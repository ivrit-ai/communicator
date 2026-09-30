import { Router } from "express";
import { ulid } from "ulid";
import { withTx } from "../db.js";
import { requireIngestToken } from "../auth-token.js";
import { requireSameOrigin, requireSession } from "../auth-session.js";
import { rateLimitIngest } from "../rate-limit.js";

// Byte limits, not character limits. A thousand four-byte emoji pass a
// 1000-character check and then fail at the push service at 4000 bytes, after
// we have already committed and told the sender 202.
const LIMITS = { title: 300, body: 2000, url: 512, dedupe_key: 200 };

// Long enough to absorb a retry storm or a redeploy gap, deliberately much
// shorter than the history window: a sender retrying a day later means a new
// event, not a duplicate.
const DEDUPE_WINDOW = "24 hours";

export function checkField(name, value, { required = false, limits = LIMITS } = {}) {
  if (value === undefined || value === null || value === "") {
    return required ? { error: `${name}_required` } : { value: null };
  }
  if (typeof value !== "string") return { error: `${name}_must_be_a_string` };
  const bytes = Buffer.byteLength(value);
  if (bytes > limits[name]) {
    return { error: `${name}_too_long`, bytes, limit: limits[name] };
  }
  return { value };
}

// Commit first, deliver second: the notification and its fanout land in one
// statement, so a container restart cannot lose an accepted send.
export async function insertAndFanOut(client, n) {
  const fanout = await client.query(
    `WITH n AS (
       INSERT INTO notifications
         (created_at, id, user_sub, source, title, body, url,
          source_id, subscription_id, subtitle, kind, lang)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING created_at, id
     )
     INSERT INTO deliveries (created_at, notification_id, device_id)
     SELECT n.created_at, n.id, d.id
       FROM n CROSS JOIN devices d
      WHERE d.user_sub = $3`,
    [
      n.createdAt,
      n.id,
      n.userSub,
      n.source,
      n.title ?? "",
      n.body ?? null,
      n.url ?? null,
      n.sourceId ?? null,
      n.subscriptionId ?? null,
      n.subtitle ?? null,
      n.kind ?? null,
      n.lang ?? null,
    ]
  );
  return fanout.rowCount;
}

// Claim the key first. A concurrent retry blocks on the unique index until this
// commits, then sees the conflict — so the duplicate is resolved by Postgres
// rather than by a check-then-act race. Returns the original id on a duplicate.
export async function claimDedupe(client, { userSub, key, id, createdAt }) {
  const claimed = await client.query(
    `INSERT INTO dedupe (user_sub, dedupe_key, notification_id, notification_created_at, expires_at)
     VALUES ($1, $2, $3, $4, now() + $5::interval)
     ON CONFLICT (user_sub, dedupe_key) DO UPDATE
       SET notification_id = EXCLUDED.notification_id,
           notification_created_at = EXCLUDED.notification_created_at,
           expires_at = EXCLUDED.expires_at
       WHERE dedupe.expires_at < now()
     RETURNING notification_id`,
    [userSub, key, id, createdAt, DEDUPE_WINDOW]
  );
  if (claimed.rowCount) return null;
  const { rows } = await client.query(
    "SELECT notification_id FROM dedupe WHERE user_sub = $1 AND dedupe_key = $2",
    [userSub, key]
  );
  return rows[0].notification_id;
}

const TEST_MESSAGE = {
  en: { title: "Test notification", body: "If you can see this, notifications work on this device.", lang: "en" },
  he: { title: "התראת בדיקה", body: "אם ההודעה הזאת מופיעה, ההתראות עובדות במכשיר הזה.", lang: "he" },
};

export function notifyRoutes(pool) {
  const router = Router();

  // Bearer only. This never touches the cookie middleware, which makes it
  // structurally impossible for CSRF to reach the ingest path.
  router.post("/api/notify", requireIngestToken(pool), rateLimitIngest, async (req, res, next) => {
    const fields = {};
    for (const [name, opts] of [
      ["title", { required: true }],
      ["body", {}],
      ["url", {}],
      ["dedupe_key", {}],
    ]) {
      const result = checkField(name, req.body?.[name], opts);
      if (result.error) return res.status(400).json({ field: name, ...result });
      fields[name] = result.value;
    }

    if (fields.url && !/^https?:\/\//i.test(fields.url)) {
      return res.status(400).json({ field: "url", error: "url_must_be_http_or_https" });
    }

    // One clock for both: GET /notifications/:id decodes the partition straight
    // out of the ULID, so its embedded timestamp and created_at must agree.
    const at = Date.now();
    const id = ulid(at);
    const createdAt = new Date(at);
    const { userSub, source } = req.ingest;

    try {
      const result = await withTx(pool, async (client) => {
        if (fields.dedupe_key) {
          const original = await claimDedupe(client, {
            userSub,
            key: fields.dedupe_key,
            id,
            createdAt,
          });
          if (original) return { id: original, devices: 0, duplicate: true };
        }

        const devices = await insertAndFanOut(client, {
          createdAt,
          id,
          userSub,
          source,
          title: fields.title,
          body: fields.body,
          url: fields.url,
        });
        return { id, devices, duplicate: false };
      });

      // 202, not 200: accepted for delivery, which is asynchronous by design.
      res.status(202).json({ id: result.id, devices: result.devices, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  });

  // Session-authenticated, because it exists to prove the round trip works on
  // the device you are holding, before you have minted any token at all.
  router.post(
    "/api/test",
    requireSession(pool),
    requireSameOrigin,
    async (req, res, next) => {
      const at = Date.now();
      try {
        const devices = await withTx(pool, (client) =>
          insertAndFanOut(client, {
            createdAt: new Date(at),
            id: ulid(at),
            userSub: req.user.sub,
            source: "Communicator",
            kind: "test",
            ...TEST_MESSAGE[req.user.locale === "he" ? "he" : "en"],
          })
        );
        res.status(202).json({ devices });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
