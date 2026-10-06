import { Router } from "express";
import { requireSameOrigin, requireSession } from "../auth-session.js";
import { hashEndpoint, validateSubscription } from "../push-endpoint.js";
import { fcmConfigured } from "../fcm.js";

const MAX_LABEL = 64;
const FCM_TOKEN = /^[A-Za-z0-9:_-]{20,4096}$/;

// A device of the ivrit.ai app on Android: its Firebase token, and the AES-256
// key it generated for itself, which messages are sealed with (see fcm.js).
function readFcm(body) {
  const token = body?.token;
  if (typeof token !== "string" || !FCM_TOKEN.test(token)) return { error: "bad_token" };
  const secret = typeof body?.key === "string" ? Buffer.from(body.key, "base64url") : null;
  if (!secret || secret.length !== 32 || secret.toString("base64url") !== body.key) return { error: "bad_key" };
  const old = typeof body?.old_token === "string" && FCM_TOKEN.test(body.old_token) ? body.old_token : null;
  return { token, secret, old };
}

function readSubscription(body) {
  return {
    endpoint: body?.endpoint,
    p256dh: body?.keys?.p256dh,
    auth: body?.keys?.auth,
  };
}

export function deviceRoutes(pool) {
  const router = Router();

  // Rotation is mounted before the session guard on purpose: it fires from a
  // `pushsubscriptionchange` event, where there may be no valid cookie at all.
  // Possession of the old endpoint is the credential.
  router.post("/api/devices/rotate", async (req, res, next) => {
    const oldEndpoint = req.body?.old_endpoint;
    if (typeof oldEndpoint !== "string" || !oldEndpoint) {
      return res.status(400).json({ error: "old_endpoint_required" });
    }
    const sub = readSubscription(req.body?.subscription);
    const invalid = validateSubscription(sub);
    if (invalid) return res.status(400).json({ error: invalid });

    try {
      const { rowCount } = await pool.query(
        `UPDATE devices
            SET endpoint_hash = $1, endpoint = $2, p256dh = $3, auth = $4, last_seen_at = now()
          WHERE endpoint_hash = $5 AND transport = 'webpush'`,
        [hashEndpoint(sub.endpoint), sub.endpoint, sub.p256dh, sub.auth, hashEndpoint(oldEndpoint)]
      );
      // A miss is not an error: the old device may already have been pruned by
      // a 410 from the push service. The client re-registers normally.
      res.json({ rotated: rowCount > 0 });
    } catch (err) {
      next(err);
    }
  });

  router.use("/api/devices", requireSession(pool));

  router.get("/api/devices", async (req, res, next) => {
    try {
      // The endpoint itself is a capability URL — anyone holding it can rotate
      // the device — so it never leaves the server, not even to its owner.
      const { rows } = await pool.query(
        `SELECT id, label, user_agent, client, transport, created_at, last_seen_at
           FROM devices WHERE user_sub = $1 ORDER BY created_at DESC`,
        [req.user.sub]
      );
      res.json({ devices: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/devices", requireSameOrigin, async (req, res, next) => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : null;
    const client = req.body?.client === "app" ? "app" : "web";
    if (label && Buffer.byteLength(label) > MAX_LABEL) {
      return res.status(400).json({ error: "label_too_long", limit: MAX_LABEL });
    }

    if (req.body?.transport === "fcm") {
      if (!fcmConfigured()) return res.status(503).json({ error: "fcm_unavailable" });
      const fcm = readFcm(req.body);
      if (fcm.error) return res.status(400).json({ error: fcm.error });
      try {
        // Firebase replaces a device's token now and then; the app sends the
        // one it had, so the old row goes rather than lingering until a send
        // comes back unregistered.
        if (fcm.old && fcm.old !== fcm.token) {
          await pool.query("DELETE FROM devices WHERE endpoint_hash = $1 AND user_sub = $2", [
            hashEndpoint(fcm.old),
            req.user.sub,
          ]);
        }
        const { rows } = await pool.query(
          `INSERT INTO devices (user_sub, endpoint_hash, endpoint, transport, secret, label, user_agent, client)
           VALUES ($1, $2, $3, 'fcm', $4, $5, $6, 'app')
           ON CONFLICT (endpoint_hash) DO UPDATE
             SET user_sub = EXCLUDED.user_sub,
                 secret = EXCLUDED.secret,
                 transport = 'fcm',
                 label = COALESCE(EXCLUDED.label, devices.label),
                 user_agent = EXCLUDED.user_agent,
                 client = 'app',
                 last_seen_at = now()
           RETURNING id, (xmax = 0) AS created`,
          [req.user.sub, hashEndpoint(fcm.token), fcm.token, fcm.secret, label, req.get("user-agent")?.slice(0, 500) ?? null]
        );
        return res.status(rows[0].created ? 201 : 200).json({ id: String(rows[0].id) });
      } catch (err) {
        return next(err);
      }
    }

    const sub = readSubscription(req.body);
    const invalid = validateSubscription(sub);
    if (invalid) return res.status(400).json({ error: invalid });

    try {
      // Idempotent by endpoint: the client re-upserts its current subscription
      // on every open, which is the only durability mechanism that works in
      // every browser. This must therefore be cheap and safe to repeat.
      const { rows } = await pool.query(
        `INSERT INTO devices (user_sub, endpoint_hash, endpoint, p256dh, auth, label, user_agent, client)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (endpoint_hash) DO UPDATE
           SET user_sub = EXCLUDED.user_sub,
               p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               label = COALESCE(EXCLUDED.label, devices.label),
               user_agent = EXCLUDED.user_agent,
               client = EXCLUDED.client,
               last_seen_at = now()
         RETURNING id, (xmax = 0) AS created`,
        [
          req.user.sub,
          hashEndpoint(sub.endpoint),
          sub.endpoint,
          sub.p256dh,
          sub.auth,
          label,
          req.get("user-agent")?.slice(0, 500) ?? null,
          client,
        ]
      );
      res.status(rows[0].created ? 201 : 200).json({ id: String(rows[0].id) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/devices/:id", requireSameOrigin, async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM devices WHERE id = $1 AND user_sub = $2",
        [req.params.id, req.user.sub]
      );
      if (!rowCount) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
