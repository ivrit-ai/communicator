import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { withTx } from "../db.js";
import { verifyPlatformIdentity } from "../auth-platform.js";
import {
  clearSessionCookie,
  createSession,
  currentUser,
  destroySession,
  forgetCachedUser,
  isAdmin,
  requireSameOrigin,
  requireSession,
  setSessionCookie,
} from "../auth-session.js";
import { adoptAnonymous, createAnonymousUser, deleteAccount } from "../accounts.js";
import { LIMITS, consume, rejectRateLimited } from "../rate-limit.js";
import { allowedAppOrigin } from "../cors.js";

const LOGIN = "/xhost-auth/login";
const LOCALES = new Set(["en", "he"]);

// Apps that sign in through the browser and take the result back (see
// readHandoff): the exact addresses Communicator may hand a code to.
const HANDOFF_TARGETS = new Set(
  (process.env.APP_HANDOFF_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean)
);
const HANDOFF_TTL_SECONDS = 120;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const sha256 = (value) => createHash("sha256").update(value).digest();

// Google refuses to sign in inside an app's web view, so the ivrit.ai app
// sends the user through the browser instead, with `handoff` (where to return)
// and `challenge` (the hash of a secret only the app holds). Communicator then
// hands back a one-time code instead of setting a cookie in the browser, and
// the app redeems it, with the secret, from its own web view. Another app
// claiming the same return address can catch the code but not redeem it.
function readHandoff(query) {
  const { handoff, challenge } = query;
  if (typeof handoff !== "string" || !HANDOFF_TARGETS.has(handoff)) return null;
  if (typeof challenge !== "string" || !CHALLENGE.test(challenge)) return null;
  return { target: handoff, challenge };
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Back to the app. A page rather than a bare redirect, so the button is there
// if the browser will not leave for the app on its own.
function handoffPage(url) {
  const href = escapeHtml(url);
  return `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ivrit.ai</title>
<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;text-align:center;padding:24px}a{display:inline-block;margin-top:12px;padding:12px 22px;border-radius:999px;background:#111;color:#fff;text-decoration:none}</style>
<div><p>מחוברים. חוזרים לאפליקציה…<br><span lang="en" dir="ltr">Signed in. Returning to the app…</span></p><a href="${href}">חזרה לאפליקציה · Back to the app</a></div>
<script>location.replace(${JSON.stringify(url).replace(/</g, "\\u003c")})</script></html>`;
}

// Where to land after signing in: a path here, or a page of an allowed
// ivrit.ai app. Anything else is ignored, so this is never an open redirect.
export function safeNext(next) {
  if (typeof next !== "string" || !next) return null;
  if (next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) return next;
  try {
    const url = new URL(next);
    return allowedAppOrigin(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

function readLocale(value) {
  return typeof value === "string" && LOCALES.has(value) ? value : null;
}

async function upsertGoogleUser(client, identity) {
  await client.query(
    `INSERT INTO users (sub, email, name, kind) VALUES ($1, $2, $3, 'google')
     ON CONFLICT (sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, last_seen_at = now()`,
    [identity.sub, identity.email, identity.name]
  );
}

export function authRoutes(pool) {
  const router = Router();

  // The platform cookie lasts 24h and, on an installed iOS PWA, the OAuth
  // redirect chain leaves manifest scope twice. It is used here exactly once,
  // as an identity assertion, and then never read again.
  router.get("/auth/complete", async (req, res, next) => {
    let identity = null;
    try {
      identity = await verifyPlatformIdentity(req);
    } catch (err) {
      console.warn(JSON.stringify({ msg: "platform_jwt_rejected", err: String(err) }));
    }

    if (!identity) {
      // Bounce to login once. Without the marker a permanently failing verify
      // (wrong host, clock skew) becomes an infinite redirect loop.
      if (req.query.retry) return res.status(401).type("text/plain").send("Sign-in failed.");
      const params = new URLSearchParams({ retry: "1" });
      if (safeNext(req.query.next)) params.set("next", req.query.next);
      const handoff = readHandoff(req.query);
      if (handoff) params.set("handoff", handoff.target), params.set("challenge", handoff.challenge);
      const back = encodeURIComponent(`/auth/complete?${params}`);
      return res.redirect(302, `${LOGIN}?return_to=${back}`);
    }

    const handoff = readHandoff(req.query);
    if (handoff) {
      try {
        const code = randomBytes(32).toString("base64url");
        await withTx(pool, async (client) => {
          await upsertGoogleUser(client, identity);
          await client.query(
            `INSERT INTO handoff_codes (code_hash, user_sub, challenge, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
            [sha256(code), identity.sub, handoff.challenge, HANDOFF_TTL_SECONDS]
          );
        });
        const url = `${handoff.target}${handoff.target.includes("?") ? "&" : "?"}code=${code}`;
        return res.set("Cache-Control", "no-store").type("html").send(handoffPage(url));
      } catch (err) {
        return next(err);
      }
    }

    try {
      // Signing in from an anonymous session is an upgrade, not a switch.
      const before = await currentUser(pool, req);
      const token = await withTx(pool, async (client) => {
        await upsertGoogleUser(client, identity);
        if (before?.kind === "anonymous") await adoptAnonymous(client, before.sub, identity.sub);
        return createSession(client, identity.sub, req.get("user-agent"));
      });
      if (before?.kind !== "anonymous") await destroySession(pool, req).catch(() => {});
      setSessionCookie(res, token);
      const upgraded = before?.kind === "anonymous";
      const landing = safeNext(req.query.next);
      if (landing) return res.redirect(302, upgraded ? `${landing.split("#")[0]}#upgraded` : landing);
      res.redirect(302, upgraded ? "/#upgraded" : "/");
    } catch (err) {
      next(err);
    }
  });

  // The app's half of the hand-off: a code from the browser, and the secret
  // whose hash came with the sign-in. Single use either way; a wrong secret
  // spends the code.
  router.post("/auth/handoff", requireSameOrigin, async (req, res, next) => {
    const { allowed, retryAfter } = consume(`handoff:${req.ip}`, LIMITS.handoff);
    if (!allowed) return rejectRateLimited(res, LIMITS.handoff, retryAfter);
    const { code, verifier } = req.body ?? {};
    if (typeof code !== "string" || code.length > 100 || typeof verifier !== "string" || !VERIFIER.test(verifier)) {
      return res.status(400).json({ error: "malformed" });
    }
    try {
      const { rows } = await pool.query(
        "DELETE FROM handoff_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_sub, challenge",
        [sha256(code)]
      );
      const expected = rows[0] && Buffer.from(rows[0].challenge);
      const actual = Buffer.from(sha256(verifier).toString("base64url"));
      if (!expected || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return res.status(400).json({ error: "invalid_code" });
      }
      const userSub = rows[0].user_sub;
      // As in /auth/complete: an anonymous account in the app becomes this one.
      const before = await currentUser(pool, req);
      const upgraded = before?.kind === "anonymous" && before.sub !== userSub;
      const token = await withTx(pool, async (client) => {
        if (upgraded) await adoptAnonymous(client, before.sub, userSub);
        return createSession(client, userSub, req.get("user-agent"));
      });
      if (!upgraded) await destroySession(pool, req).catch(() => {});
      setSessionCookie(res, token);
      res.json({ ok: true, upgraded });
    } catch (err) {
      next(err);
    }
  });

  // No Google, no email: the account is this browser's cookie and nothing else.
  router.post("/auth/anonymous", requireSameOrigin, async (req, res, next) => {
    const { allowed, retryAfter } = consume(`anon:${req.ip}`, LIMITS.anonymous);
    if (!allowed) return rejectRateLimited(res, LIMITS.anonymous, retryAfter);
    try {
      const existing = await currentUser(pool, req);
      if (existing) return res.json({ ok: true, existing: true });
      const token = await withTx(pool, async (client) => {
        const sub = await createAnonymousUser(client, readLocale(req.body?.locale));
        return createSession(client, sub, req.get("user-agent"));
      });
      setSessionCookie(res, token);
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/me", requireSession(pool), (req, res) => {
    res.json({ ...req.user, is_admin: isAdmin(req.user) });
  });

  router.patch("/api/me", requireSession(pool), requireSameOrigin, async (req, res, next) => {
    if (!("locale" in (req.body ?? {}))) return res.status(400).json({ error: "nothing_to_update" });
    const locale = req.body.locale === null ? null : readLocale(req.body.locale);
    if (req.body.locale !== null && !locale) return res.status(400).json({ error: "bad_locale" });
    try {
      await pool.query("UPDATE users SET locale = $2 WHERE sub = $1", [req.user.sub, locale]);
      res.json({ ok: true, locale });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/me", requireSession(pool), requireSameOrigin, async (req, res, next) => {
    try {
      await withTx(pool, (client) => deleteAccount(client, req.user.sub));
      forgetCachedUser(req.user.sub);
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/logout", requireSameOrigin, async (req, res, next) => {
    try {
      await destroySession(pool, req);
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
