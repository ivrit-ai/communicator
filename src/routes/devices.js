import { Router } from "express";
import { requireSameOrigin, requireSession } from "../auth-session.js";
import { hashEndpoint, validateSubscription } from "../push-endpoint.js";

const MAX_LABEL = 64;

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
          WHERE endpoint_hash = $5`,
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
        `SELECT id, label, user_agent, created_at, last_seen_at
           FROM devices WHERE user_sub = $1 ORDER BY created_at DESC`,
        [req.user.sub]
      );
      res.json({ devices: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/devices", requireSameOrigin, async (req, res, next) => {
    const sub = readSubscription(req.body);
    const invalid = validateSubscription(sub);
    if (invalid) return res.status(400).json({ error: invalid });

    const label = typeof req.body?.label === "string" ? req.body.label.trim() : null;
    if (label && Buffer.byteLength(label) > MAX_LABEL) {
      return res.status(400).json({ error: "label_too_long", limit: MAX_LABEL });
    }

    try {
      // Idempotent by endpoint: the client re-upserts its current subscription
      // on every open, which is the only durability mechanism that works in
      // every browser. This must therefore be cheap and safe to repeat.
      const { rows } = await pool.query(
        `INSERT INTO devices (user_sub, endpoint_hash, endpoint, p256dh, auth, label, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (endpoint_hash) DO UPDATE
           SET user_sub = EXCLUDED.user_sub,
               p256dh = EXCLUDED.p256dh,
               auth = EXCLUDED.auth,
               label = COALESCE(EXCLUDED.label, devices.label),
               user_agent = EXCLUDED.user_agent,
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
