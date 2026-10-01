import { Router } from "express";
import { ulid } from "ulid";
import { requireSameOrigin, requireSession } from "../auth-session.js";
import { CODE_TTL_MINUTES, generateCode, hashCode, normalizeCode } from "../link-code.js";
import { LIMITS, consume, rejectRateLimited } from "../rate-limit.js";
import { MAX_SUBSCRIPTIONS } from "./source-api.js";
import { countLinkCodes } from "../link-stats.js";

function fill(template, code) {
  return template ? template.replaceAll("{code}", code) : null;
}

// What a user is shown for a source: never its key, never who else uses it.
function publicSource(row) {
  return {
    id: row.id,
    name: row.name,
    name_he: row.name_he,
    description: row.description,
    description_he: row.description_he,
    accent: row.accent,
    icon: row.icon_etag ? `/api/sources/${row.id}/icon.png?v=${row.icon_etag}` : null,
  };
}

export function linkRoutes(pool) {
  const router = Router();

  // Public and long-cached: notifications reference it as their icon, and the
  // service worker fetches it with no session at all.
  router.get("/api/sources/:id/icon.png", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT icon_png, icon_etag FROM sources WHERE id = $1 AND icon_png IS NOT NULL",
        [req.params.id]
      );
      if (!rows.length) return res.status(404).end();
      const etag = `"${rows[0].icon_etag}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=86400");
      if (req.get("if-none-match") === etag) return res.status(304).end();
      res.type("image/png").send(rows[0].icon_png);
    } catch (err) {
      next(err);
    }
  });

  router.use(["/api/sources", "/api/links", "/api/subscriptions"], requireSession(pool));

  router.get("/api/sources", async (req, res, next) => {
    try {
      const [sources, subscriptions] = await Promise.all([
        pool.query(
          `SELECT id, name, name_he, description, description_he, accent, icon_etag, link_methods
             FROM sources WHERE enabled ORDER BY created_at`
        ),
        pool.query(
          `SELECT id, source_id, label, created_at, last_message_at
             FROM subscriptions
            WHERE user_sub = $1 AND revoked_at IS NULL
            ORDER BY created_at`,
          [req.user.sub]
        ),
      ]);
      res.json({
        sources: sources.rows.map((row) => ({
          ...publicSource(row),
          methods: row.link_methods.map((m) => ({ label: m.label, label_he: m.label_he })),
        })),
        subscriptions: subscriptions.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/links", requireSameOrigin, async (req, res, next) => {
    const sourceId = req.body?.source_id;
    if (typeof sourceId !== "string") return res.status(400).json({ error: "source_id_required" });
    const { allowed, retryAfter } = consume(`link:${req.user.sub}`, LIMITS.linkCode);
    if (!allowed) return rejectRateLimited(res, LIMITS.linkCode, retryAfter);

    try {
      const { rows } = await pool.query(
        "SELECT link_methods FROM sources WHERE id = $1 AND enabled",
        [sourceId]
      );
      if (!rows.length) return res.status(404).json({ error: "unknown_source" });
      const { rows: count } = await pool.query(
        "SELECT count(*)::int AS n FROM subscriptions WHERE user_sub = $1 AND revoked_at IS NULL",
        [req.user.sub]
      );
      if (count[0].n >= MAX_SUBSCRIPTIONS) {
        return res.status(409).json({ error: "too_many_subscriptions", limit: MAX_SUBSCRIPTIONS });
      }

      const id = ulid();
      const code = generateCode();
      // One live code per user and source: an earlier one on another tab
      // stops working, so there is never a question of which one counts.
      const replaced = await pool.query(
        "DELETE FROM link_codes WHERE user_sub = $1 AND source_id = $2 AND state = 'pending'",
        [req.user.sub, sourceId]
      );
      await countLinkCodes(pool, sourceId, "replaced", replaced.rowCount);
      const { rows: inserted } = await pool.query(
        `INSERT INTO link_codes (id, code_hash, user_sub, source_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
         RETURNING expires_at`,
        [id, hashCode(normalizeCode(code)), req.user.sub, sourceId, CODE_TTL_MINUTES]
      );
      await countLinkCodes(pool, sourceId, "created");
      res.status(201).json({
        link_id: id,
        code,
        expires_at: inserted[0].expires_at,
        methods: rows[0].link_methods.map((m) => ({
          label: m.label,
          label_he: m.label_he,
          url: fill(m.url_template, code),
          text: fill(m.text_template, code),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Polled by the link sheet while it is open.
  router.get("/api/links/:id", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT l.state, l.expires_at, l.expires_at < now() AS expired,
                s.id AS subscription_id, s.label, s.source_id, s.created_at
           FROM link_codes l
           LEFT JOIN subscriptions s ON s.id = l.subscription_id
          WHERE l.id = $1 AND l.user_sub = $2`,
        [req.params.id, req.user.sub]
      );
      if (!rows.length) return res.status(404).json({ error: "not_found" });
      const row = rows[0];
      const state = row.state === "pending" && row.expired ? "expired" : row.state;
      res.json({
        state,
        expires_at: row.expires_at,
        subscription:
          state === "linked"
            ? { id: row.subscription_id, label: row.label, source_id: row.source_id, created_at: row.created_at }
            : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // The source learns on its next send (410) and unbinds on its side.
  router.delete("/api/subscriptions/:id", requireSameOrigin, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE subscriptions SET revoked_at = now()
          WHERE id = $1 AND user_sub = $2 AND revoked_at IS NULL`,
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
