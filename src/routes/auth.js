import { Router } from "express";
import { withTx } from "../db.js";
import { verifyPlatformIdentity } from "../auth-platform.js";
import {
  clearSessionCookie,
  createSession,
  currentUser,
  destroySession,
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
      const nextParam = safeNext(req.query.next) ? `&next=${encodeURIComponent(req.query.next)}` : "";
      const back = encodeURIComponent(`/auth/complete?retry=1${nextParam}`);
      return res.redirect(302, `${LOGIN}?return_to=${back}`);
    }

    try {
      // Signing in from an anonymous session is an upgrade, not a switch.
      const before = await currentUser(pool, req);
      const token = await withTx(pool, async (client) => {
        await client.query(
          `INSERT INTO users (sub, email, name, kind) VALUES ($1, $2, $3, 'google')
           ON CONFLICT (sub) DO UPDATE
             SET email = EXCLUDED.email, name = EXCLUDED.name, last_seen_at = now()`,
          [identity.sub, identity.email, identity.name]
        );
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
