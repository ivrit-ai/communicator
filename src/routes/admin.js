import { createHash } from "node:crypto";
import { Router } from "express";
import { requireAdmin, requireSameOrigin, requireSession } from "../auth-session.js";
import { SOURCE_ID, evictSource, generateSourceKey } from "../auth-source.js";

const TEXT_LIMITS = { name: 64, name_he: 64, description: 300, description_he: 300 };
const MAX_METHODS = 4;
const MAX_ICON_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bad(field, error) {
  return { field, error };
}

// Link methods are what the user taps to hand a code to the source: a URL that
// opens the right app with the message prefilled, and the literal text for
// when that does not work. Both must contain {code}, or the user has nothing
// to send.
function readMethods(value) {
  if (!Array.isArray(value) || value.length > MAX_METHODS) return { error: bad("link_methods", "bad_link_methods") };
  const methods = [];
  for (const m of value) {
    const label = typeof m?.label === "string" ? m.label.trim() : "";
    const labelHe = typeof m?.label_he === "string" ? m.label_he.trim() : "";
    const url = typeof m?.url_template === "string" ? m.url_template.trim() : "";
    const text = typeof m?.text_template === "string" ? m.text_template.trim() : "";
    if (!label || label.length > 40 || labelHe.length > 40) return { error: bad("link_methods", "bad_label") };
    if (url && (!/^(https:\/\/|tg:\/\/)/.test(url) || url.length > 300 || !url.includes("{code}"))) {
      return { error: bad("link_methods", "bad_url_template") };
    }
    if (!text || text.length > 200 || !text.includes("{code}")) {
      return { error: bad("link_methods", "bad_text_template") };
    }
    methods.push({ label, label_he: labelHe || null, url_template: url || null, text_template: text });
  }
  return { value: methods };
}

// The subset of a source's fields present in body, validated. Used for both
// create (all required ones present) and update (any subset).
function readFields(body) {
  const out = {};
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    if (!(field in body)) continue;
    const v = body[field] === null ? null : typeof body[field] === "string" ? body[field].trim() : undefined;
    if (v === undefined || (v && v.length > limit)) return { error: bad(field, `bad_${field}`) };
    out[field] = v || null;
  }
  if ("accent" in body) {
    if (body.accent !== null && !/^#[0-9a-fA-F]{6}$/.test(body.accent)) return { error: bad("accent", "bad_accent") };
    out.accent = body.accent;
  }
  if ("rate_per_minute" in body) {
    const n = Number(body.rate_per_minute);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) return { error: bad("rate_per_minute", "bad_rate") };
    out.rate_per_minute = n;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return { error: bad("enabled", "bad_enabled") };
    out.enabled = body.enabled;
  }
  if ("link_methods" in body) {
    const methods = readMethods(body.link_methods);
    if (methods.error) return methods;
    out.link_methods = JSON.stringify(methods.value);
  }
  return { value: out };
}

const COLUMNS = `s.id, s.name, s.name_he, s.description, s.description_he, s.accent, s.icon_etag,
  s.link_methods, s.key_prefix, s.rate_per_minute, s.enabled, s.created_at,
  (SELECT count(*)::int FROM subscriptions x WHERE x.source_id = s.id AND x.revoked_at IS NULL) AS subscriptions`;

export function adminRoutes(pool) {
  const router = Router();
  router.use("/api/admin", requireSession(pool), requireAdmin);

  router.get("/api/admin/sources", async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM sources s ORDER BY s.created_at`);
      res.json({ sources: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/admin/sources", requireSameOrigin, async (req, res, next) => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!SOURCE_ID.test(id)) return res.status(400).json(bad("id", "bad_id"));
    const fields = readFields(req.body);
    if (fields.error) return res.status(400).json(fields.error);
    if (!fields.value.name) return res.status(400).json(bad("name", "name_required"));

    const { wire, keyHash, keyPrefix } = generateSourceKey(id);
    const values = { ...fields.value, id, key_hash: keyHash, key_prefix: keyPrefix };
    const names = Object.keys(values);
    try {
      await pool.query(
        `INSERT INTO sources (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((n) => values[n])
      );
      evictSource(id);
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM sources s WHERE s.id = $1`, [id]);
      // The only time this key leaves the server.
      res.status(201).json({ source: rows[0], key: wire });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json(bad("id", "id_taken"));
      next(err);
    }
  });

  router.patch("/api/admin/sources/:id", requireSameOrigin, async (req, res, next) => {
    const fields = readFields(req.body ?? {});
    if (fields.error) return res.status(400).json(fields.error);
    if ("name" in fields.value && !fields.value.name) return res.status(400).json(bad("name", "name_required"));
    const names = Object.keys(fields.value);
    if (!names.length) return res.status(400).json({ error: "nothing_to_update" });
    try {
      const { rowCount } = await pool.query(
        `UPDATE sources SET ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [req.params.id, ...names.map((n) => fields.value[n])]
      );
      if (!rowCount) return res.status(404).json({ error: "not_found" });
      evictSource(req.params.id);
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM sources s WHERE s.id = $1`, [req.params.id]);
      res.json({ source: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/admin/sources/:id", requireSameOrigin, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM sources WHERE id = $1", [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "not_found" });
      evictSource(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // The browser rasterises whatever the admin picked (SVG, a large PNG) to a
  // square PNG before uploading, so the server only ever checks a signature
  // and a size, and never parses an image.
  router.put("/api/admin/sources/:id/icon", requireSameOrigin, async (req, res, next) => {
    const png = req.body;
    if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return res.status(400).json({ error: "png_required" });
    }
    if (png.length > MAX_ICON_BYTES) return res.status(400).json({ error: "icon_too_large", limit: MAX_ICON_BYTES });
    const etag = createHash("sha256").update(png).digest("base64url").slice(0, 16);
    try {
      const { rowCount } = await pool.query(
        "UPDATE sources SET icon_png = $2, icon_etag = $3 WHERE id = $1",
        [req.params.id, png, etag]
      );
      if (!rowCount) return res.status(404).json({ error: "not_found" });
      res.json({ icon_etag: etag });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/admin/sources/:id/key", requireSameOrigin, async (req, res, next) => {
    const { wire, keyHash, keyPrefix } = generateSourceKey(req.params.id);
    try {
      const { rowCount } = await pool.query(
        "UPDATE sources SET key_hash = $2, key_prefix = $3 WHERE id = $1",
        [req.params.id, keyHash, keyPrefix]
      );
      if (!rowCount) return res.status(404).json({ error: "not_found" });
      // The old key must stop working now, not when the cache entry ages out.
      evictSource(req.params.id);
      res.json({ key: wire, key_prefix: keyPrefix });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
