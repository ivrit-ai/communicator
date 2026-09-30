import { Router } from "express";
import { decodeTime } from "ulid";
import { requireSameOrigin, requireSession } from "../auth-session.js";
import { RETENTION_DAYS } from "../migrate.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_READ_IDS = 200;
const WINDOW = `${RETENTION_DAYS} days`;

// What a device stores. Qualified, because the ack route joins deliveries.
export const NOTIFICATION_COLUMNS = `n.id, n.created_at, n.source, n.source_id, n.title, n.subtitle,
  n.body, n.url, n.kind, n.lang, n.read_at`;

function partitionKey(id) {
  try {
    return new Date(decodeTime(id));
  } catch {
    return null;
  }
}

export function notificationRoutes(pool) {
  const router = Router();
  router.use("/api/notifications", requireSession(pool));

  // Newest first with ?before= (paging back through history), or oldest first
  // with ?after= (a device catching up from the last message it has).
  router.get("/api/notifications", async (req, res, next) => {
    const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const before = typeof req.query.before === "string" ? req.query.before : null;
    const after = typeof req.query.after === "string" ? req.query.after : null;
    if (before && after) return res.status(400).json({ error: "before_or_after" });
    const cursorId = before ?? after;
    const cursor = cursorId ? partitionKey(cursorId) : null;
    if (cursorId && !cursor) return res.status(400).json({ error: "bad_cursor" });

    try {
      // Keyset, not OFFSET: the ULID doubles as the cursor, and the lower bound
      // on created_at lets Postgres skip the partitions that cannot contain
      // anything rather than opening one index per retained day.
      const { rows } = await pool.query(
        after
          ? `SELECT ${NOTIFICATION_COLUMNS}
               FROM notifications n
              WHERE n.user_sub = $1
                AND n.created_at > now() - $2::interval
                AND (n.created_at, n.id) > ($3, $4)
              ORDER BY n.created_at, n.id
              LIMIT $5`
          : `SELECT ${NOTIFICATION_COLUMNS}
               FROM notifications n
              WHERE n.user_sub = $1
                AND n.created_at > now() - $2::interval
                AND ($3::timestamptz IS NULL OR (n.created_at, n.id) < ($3, $4))
              ORDER BY n.created_at DESC, n.id DESC
              LIMIT $5`,
        [req.user.sub, WINDOW, cursor, cursorId, limit]
      );
      res.json({
        notifications: rows,
        next: rows.length === limit ? rows[rows.length - 1].id : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/notifications/:id", async (req, res, next) => {
    const createdAt = partitionKey(req.params.id);
    if (!createdAt) return res.status(404).json({ error: "not_found" });
    try {
      const { rows } = await pool.query(
        `SELECT ${NOTIFICATION_COLUMNS}
           FROM notifications n
          WHERE n.created_at = $1 AND n.id = $2 AND n.user_sub = $3`,
        [createdAt, req.params.id, req.user.sub]
      );
      // user_sub is part of the predicate, not checked afterwards: this is the
      // one route where forgetting it would be a silent IDOR.
      if (!rows.length) return res.status(404).json({ error: "not_found" });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/notifications/read", requireSameOrigin, async (req, res, next) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids_required" });
    if (ids.length > MAX_READ_IDS) {
      return res.status(400).json({ error: "too_many_ids", limit: MAX_READ_IDS });
    }

    const times = [];
    for (const id of ids) {
      const at = typeof id === "string" ? partitionKey(id) : null;
      if (!at) return res.status(400).json({ error: "bad_id", id });
      times.push(at);
    }

    try {
      const { rowCount } = await pool.query(
        `UPDATE notifications n SET read_at = now()
           FROM unnest($2::timestamptz[], $3::text[]) AS t(created_at, id)
          WHERE n.user_sub = $1
            AND n.created_at = t.created_at
            AND n.id = t.id
            AND n.read_at IS NULL`,
        [req.user.sub, times, ids]
      );
      res.json({ updated: rowCount });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
