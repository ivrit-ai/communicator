import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import { ulid } from "ulid";
import { withTx } from "../db.js";
import { requireSourceKey } from "../auth-source.js";
import { hashCode, normalizeCode } from "../link-code.js";
import { LIMITS, consume, rejectRateLimited } from "../rate-limit.js";
import { checkField, claimDedupe, insertAndFanOut } from "./notify.js";

// Transcripts are long: a ten-minute voice note in Hebrew runs to ~15 KB of
// UTF-8. The push itself carries a preview; the device fetches the rest.
const LIMITS_SOURCE = {
  body: 64 * 1024,
  title: 300,
  subtitle: 200,
  url: 512,
  kind: 32,
  lang: 16,
  dedupe_key: 200,
  label: 64,
  subject: 200,
};

export const MAX_SUBSCRIPTIONS = 20;

function subjectHash(sourceId, subject) {
  return createHash("sha256").update(`${sourceId}:${subject}`).digest();
}

export function sourceApiRoutes(pool) {
  const router = Router();
  router.use("/api/source/v1", requireSourceKey(pool));

  // The source is telling us someone handed it a code. The subject is the
  // source's own stable id for that someone (Eliezer: the WhatsApp number or
  // Telegram chat), and makes a retried redeem return the same subscription
  // instead of failing as "already used".
  router.post("/api/source/v1/links", async (req, res, next) => {
    const code = normalizeCode(req.body?.code);
    if (!code) return res.status(404).json({ error: "unknown_code" });
    const subject = checkField("subject", req.body?.subject, { required: true, limits: LIMITS_SOURCE });
    if (subject.error) return res.status(400).json({ field: "subject", ...subject });
    const label = checkField("label", req.body?.label, { limits: LIMITS_SOURCE });
    if (label.error) return res.status(400).json({ field: "label", ...label });
    const subjectKey = subjectHash(req.source.id, subject.value);

    try {
      const result = await withTx(pool, async (client) => {
        const { rows } = await client.query(
          `SELECT l.id, l.user_sub, l.state, l.subscription_id, l.expires_at < now() AS expired,
                  s.subject_hash, s.revoked_at
             FROM link_codes l
             LEFT JOIN subscriptions s ON s.id = l.subscription_id
            WHERE l.code_hash = $1 AND l.source_id = $2
            FOR UPDATE OF l`,
          [hashCode(code), req.source.id]
        );
        const link = rows[0];
        // A code for a different source is, to this source, a code that does
        // not exist.
        if (!link) return { status: 404, body: { error: "unknown_code" } };

        if (link.state === "linked") {
          const same = link.subject_hash && !link.revoked_at && link.subject_hash.equals(subjectKey);
          return same
            ? { status: 200, body: { subscription_id: link.subscription_id } }
            : { status: 409, body: { error: "already_used" } };
        }
        if (link.expired || link.state !== "pending") {
          // Recorded, so the page the user is watching can say "that code
          // expired" instead of spinning until they give up.
          await client.query(
            "UPDATE link_codes SET state = 'expired_attempt' WHERE id = $1 AND state = 'pending'",
            [link.id]
          );
          return { status: 410, body: { error: "expired_code" } };
        }

        // Linking again from the same subject is the same link: hand back the
        // live subscription rather than a second one that would double every
        // message.
        const existing = await client.query(
          `SELECT id FROM subscriptions
            WHERE user_sub = $1 AND source_id = $2 AND subject_hash = $3 AND revoked_at IS NULL`,
          [link.user_sub, req.source.id, subjectKey]
        );
        let subscriptionId = existing.rows[0]?.id;
        if (subscriptionId) {
          await client.query("UPDATE subscriptions SET label = COALESCE($2, label) WHERE id = $1", [
            subscriptionId,
            label.value,
          ]);
        } else {
          const { rows: count } = await client.query(
            "SELECT count(*)::int AS n FROM subscriptions WHERE user_sub = $1 AND revoked_at IS NULL",
            [link.user_sub]
          );
          if (count[0].n >= MAX_SUBSCRIPTIONS) {
            return { status: 409, body: { error: "too_many_subscriptions", limit: MAX_SUBSCRIPTIONS } };
          }
          // 128 random bits: this id is the source's whole address for the
          // user, and the only thing it ever needs to send them anything.
          subscriptionId = randomBytes(16).toString("base64url");
          await client.query(
            `INSERT INTO subscriptions (id, user_sub, source_id, subject_hash, label)
             VALUES ($1, $2, $3, $4, $5)`,
            [subscriptionId, link.user_sub, req.source.id, subjectKey, label.value]
          );
        }
        await client.query(
          "UPDATE link_codes SET state = 'linked', subscription_id = $2 WHERE id = $1",
          [link.id, subscriptionId]
        );
        return { status: 201, body: { subscription_id: subscriptionId } };
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/source/v1/messages", async (req, res, next) => {
    const sourceLimit = { perMinute: req.source.perMinute };
    const bySource = consume(`source:${req.source.id}`, sourceLimit);
    if (!bySource.allowed) return rejectRateLimited(res, sourceLimit, bySource.retryAfter);

    const subscriptionId = req.body?.subscription_id;
    if (typeof subscriptionId !== "string" || !subscriptionId) {
      return res.status(400).json({ field: "subscription_id", error: "subscription_id_required" });
    }

    const fields = {};
    for (const name of ["body", "title", "subtitle", "url", "kind", "lang", "dedupe_key"]) {
      const result = checkField(name, req.body?.[name], { limits: LIMITS_SOURCE });
      if (result.error) return res.status(400).json({ field: name, ...result });
      fields[name] = result.value;
    }
    if (!fields.body && !fields.title) {
      return res.status(400).json({ field: "body", error: "body_or_title_required" });
    }
    if (fields.url && !/^https?:\/\//i.test(fields.url)) {
      return res.status(400).json({ field: "url", error: "url_must_be_http_or_https" });
    }

    try {
      const { rows } = await pool.query(
        `SELECT user_sub FROM subscriptions
          WHERE id = $1 AND source_id = $2 AND revoked_at IS NULL`,
        [subscriptionId, req.source.id]
      );
      // Gone, whether revoked by the user, deleted with their account, or never
      // this source's: the source should stop sending here and unbind.
      if (!rows.length) return res.status(410).json({ error: "unlinked" });
      const userSub = rows[0].user_sub;

      const bySubscription = consume(`subscription:${subscriptionId}`, LIMITS.subscription);
      if (!bySubscription.allowed) {
        return rejectRateLimited(res, LIMITS.subscription, bySubscription.retryAfter);
      }

      const at = Date.now();
      const id = ulid(at);
      const createdAt = new Date(at);
      const result = await withTx(pool, async (client) => {
        if (fields.dedupe_key) {
          const original = await claimDedupe(client, {
            userSub,
            key: `src:${req.source.id}:${fields.dedupe_key}`,
            id,
            createdAt,
          });
          if (original) return { id: original, devices: 0, duplicate: true };
        }
        const devices = await insertAndFanOut(client, {
          createdAt,
          id,
          userSub,
          source: req.source.name,
          sourceId: req.source.id,
          subscriptionId,
          title: fields.title,
          body: fields.body,
          url: fields.url,
          subtitle: fields.subtitle,
          kind: fields.kind,
          lang: fields.lang,
        });
        await client.query(
          `UPDATE subscriptions SET last_message_at = now()
            WHERE id = $1 AND (last_message_at IS NULL OR last_message_at < now() - interval '1 minute')`,
          [subscriptionId]
        );
        return { id, devices, duplicate: false };
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  // The source's side of unlinking (the user said "stop" to it directly).
  // Idempotent: unlinking something already unlinked succeeds.
  router.delete("/api/source/v1/subscriptions/:id", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `UPDATE subscriptions SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1 AND source_id = $2
          RETURNING id`,
        [req.params.id, req.source.id]
      );
      if (!rows.length) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
