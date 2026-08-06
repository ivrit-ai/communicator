import { Router } from "express";
import { withTx } from "../db.js";
import { verifyPlatformIdentity } from "../auth-platform.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireSameOrigin,
  requireSession,
  setSessionCookie,
} from "../auth-session.js";

const LOGIN = "/xhost-auth/login";

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
      const back = encodeURIComponent("/auth/complete?retry=1");
      return res.redirect(302, `${LOGIN}?return_to=${back}`);
    }

    try {
      const token = await withTx(pool, async (client) => {
        await client.query(
          `INSERT INTO users (sub, email, name) VALUES ($1, $2, $3)
           ON CONFLICT (sub) DO UPDATE
             SET email = EXCLUDED.email, name = EXCLUDED.name, last_seen_at = now()`,
          [identity.sub, identity.email, identity.name]
        );
        return createSession(client, identity.sub, req.get("user-agent"));
      });
      setSessionCookie(res, token);
      res.redirect(302, "/");
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/me", requireSession(pool), (req, res) => {
    res.json(req.user);
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
