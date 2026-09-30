import { Router } from "express";
import { decodeTime } from "ulid";
import { verifyAck } from "../ack.js";
import { NOTIFICATION_COLUMNS } from "./notifications.js";

// The ULID's first 48 bits are the creation time, and the notification was
// written with exactly that instant as created_at. So the partition is
// recoverable from the id alone, with no lookup and no scan across every day.
function partitionKey(id) {
  try {
    return new Date(decodeTime(id));
  } catch {
    return null;
  }
}

export function ackRoutes(pool) {
  const router = Router();

  // No cookie, by design. The app may have been closed for days, so the session
  // is likely expired; the signed token in the push payload is the credential.
  router.post("/api/ack", async (req, res, next) => {
    const id = req.body?.i;
    const deviceId = req.body?.d;
    const token = req.body?.k;

    if (typeof id !== "string" || !/^\d+$/.test(String(deviceId ?? ""))) {
      return res.status(400).json({ error: "malformed" });
    }
    if (!verifyAck(id, deviceId, token)) {
      return res.status(403).json({ error: "bad_ack_token" });
    }

    const createdAt = partitionKey(id);
    if (!createdAt) return res.status(400).json({ error: "malformed_id" });

    try {
      // Acking also settles the delivery so the sender stops retrying. It does
      // not delete anything: rows live the full retention window so history
      // stays browsable and a newly registered device still sees the backlog.
      const { rowCount } = await pool.query(
        `UPDATE deliveries
            SET acked_at = now(), state = 'sent'
          WHERE created_at = $1 AND notification_id = $2 AND device_id = $3
            AND acked_at IS NULL`,
        [createdAt, id, deviceId]
      );
      // The push carried at most a preview. The signed ack proves this device
      // was sent this notification, which is exactly the right to read it in
      // full, with no session: the app may not have been opened in days.
      const { rows } = await pool.query(
        `SELECT ${NOTIFICATION_COLUMNS}
           FROM notifications n
           JOIN deliveries d ON d.created_at = n.created_at AND d.notification_id = n.id
          WHERE n.created_at = $1 AND n.id = $2 AND d.device_id = $3`,
        [createdAt, id, deviceId]
      );
      // Re-acking is not an error: the service worker may fire twice, and the
      // client must never be pushed into a retry loop by a 4xx here.
      res.json({ ok: true, first: rowCount > 0, notification: rows[0] ?? null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
