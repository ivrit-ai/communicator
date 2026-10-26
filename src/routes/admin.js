import { createHash } from "node:crypto";
import { Router } from "express";
import { ulid } from "ulid";
import { requireAdmin, requireSameOrigin, requireSession } from "../auth-session.js";
import { SOURCE_ID, evictSource, generateSourceKey } from "../auth-source.js";
import { withTx } from "../db.js";
import { checkField, insertAndFanOut } from "./notify.js";

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
  if ("addresses_accounts" in body) {
    if (typeof body.addresses_accounts !== "boolean") return { error: bad("addresses_accounts", "bad_addresses_accounts") };
    out.addresses_accounts = body.addresses_accounts;
  }
  if ("link_methods" in body) {
    const methods = readMethods(body.link_methods);
    if (methods.error) return methods;
    out.link_methods = JSON.stringify(methods.value);
  }
  return { value: out };
}

// --- announcements
//
// A message from an admin to every account in an audience, sent as one of the
// sources (so it shows with that source's name and mark), once per account
// ever: announcement_sends remembers who has it, by the announcement's key.
//
// The one audience so far: people on Android who are not in the ivrit.ai app.
// On Android is a web push device, or a sign-in to this site, from an Android
// browser (an Android web view, "; wv)", is an app, not a browser). In the app
// is having a device the app registered with Firebase or Apple; a web push
// device marked client 'app' is app.ivrit.ai in a browser, which still counts
// as not in the app. An app user who never allowed notifications has no such
// device, and cannot be told apart.
const ANDROID_WITHOUT_APP = `
  SELECT u.sub, u.kind, u.locale,
         EXISTS (SELECT 1 FROM devices d WHERE d.user_sub = u.sub) AS reachable,
         EXISTS (SELECT 1 FROM announcement_sends a WHERE a.announcement = $1 AND a.user_sub = u.sub) AS sent
    FROM users u
   WHERE (EXISTS (SELECT 1 FROM devices d WHERE d.user_sub = u.sub AND d.transport = 'webpush'
                     AND d.user_agent ~ 'Android' AND d.user_agent !~ '; wv\\)')
          OR EXISTS (SELECT 1 FROM sessions s WHERE s.user_sub = u.sub
                        AND s.user_agent ~ 'Android' AND s.user_agent !~ '; wv\\)'))
     AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.user_sub = u.sub AND d.transport IN ('fcm', 'apns'))`;

const ANNOUNCEMENT_KEY = /^[a-z0-9-]{1,64}$/;

// Which text an account reads: English if it chose English, else Hebrew (also
// for Yiddish, which reads Hebrew script). Anonymous accounts have no Google
// account to sign in with, so they get their own text, or nothing.
function textFor(user, texts) {
  const lang = user.locale === "en" ? "en" : "he";
  const set = user.kind === "anonymous" ? texts.anonymous : texts;
  return set?.[lang] ? { ...set[lang], lang } : null;
}

function readText(value, where) {
  const out = {};
  for (const [name, opts] of [["title", { required: true }], ["body", {}]]) {
    const result = checkField(name, value?.[name], opts);
    if (result.error) return { error: { field: `${where}.${name}`, ...result } };
    out[name] = result.value;
  }
  return { value: out };
}

function readAnnouncement(body) {
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!ANNOUNCEMENT_KEY.test(key)) return { error: bad("key", "bad_key") };
  const url = checkField("url", body.url);
  if (url.error) return { error: { field: "url", ...url } };
  if (url.value && !/^https:\/\//i.test(url.value)) return { error: bad("url", "url_must_be_https") };
  const texts = {};
  for (const lang of ["he", "en"]) {
    const text = readText(body[lang], lang);
    if (text.error) return text;
    texts[lang] = text.value;
  }
  if (body.anonymous) {
    texts.anonymous = {};
    for (const lang of ["he", "en"]) {
      const text = readText(body.anonymous[lang], `anonymous.${lang}`);
      if (text.error) return text;
      texts.anonymous[lang] = text.value;
    }
  }
  const sourceId = typeof body.source_id === "string" ? body.source_id : "";
  return { value: { key, url: url.value, texts, sourceId } };
}

function countAudience(rows, texts) {
  const due = rows.filter((r) => !r.sent);
  const counted = due.filter((r) => !texts || textFor(r, texts));
  const locale = (r) => (r.locale === "en" ? "en" : r.locale === "he" || r.locale === "yi" || !r.locale ? "he" : "other");
  return {
    total: counted.length,
    notified: counted.filter((r) => r.reachable).length,
    inbox_only: counted.filter((r) => !r.reachable).length,
    by_locale: Object.fromEntries(["he", "en", "other"].map((l) => [l, counted.filter((r) => locale(r) === l).length])),
    anonymous: counted.filter((r) => r.kind === "anonymous").length,
    // Anonymous accounts left out for want of their own text.
    skipped: due.length - counted.length,
    already_sent: rows.length - due.length,
  };
}

const COLUMNS = `s.id, s.name, s.name_he, s.description, s.description_he, s.accent, s.icon_etag,
  s.link_methods, s.key_prefix, s.rate_per_minute, s.enabled, s.addresses_accounts, s.created_at,
  (SELECT count(*)::int FROM subscriptions x WHERE x.source_id = s.id AND x.revoked_at IS NULL) AS subscriptions`;

export function adminRoutes(pool) {
  const router = Router();
  router.use("/api/admin", requireSession(pool), requireAdmin);

  router.get("/api/admin/sources", async (req, res, next) => {
    try {
      const [{ rows }, { rows: platforms }, { rows: stats }] = await Promise.all([
        pool.query(`SELECT ${COLUMNS} FROM sources s ORDER BY s.created_at`),
        // Each linked user by the platforms of their devices, read from the user
        // agent the device registered with. A user with an iPhone and a laptop
        // counts under both; one whose devices are all gone counts as none.
        pool.query(
          `SELECT x.source_id,
                  count(DISTINCT x.user_sub) FILTER (WHERE d.platform = 'iphone')::int AS iphone,
                  count(DISTINCT x.user_sub) FILTER (WHERE d.platform = 'android')::int AS android,
                  count(DISTINCT x.user_sub) FILTER (WHERE d.platform = 'other')::int AS other,
                  count(DISTINCT x.user_sub) FILTER (WHERE d.platform IS NULL)::int AS none,
                  count(DISTINCT x.user_sub) FILTER (WHERE d.client = 'app')::int AS app
             FROM subscriptions x
             LEFT JOIN LATERAL (
               SELECT CASE WHEN user_agent ~ 'iPhone|iPad' THEN 'iphone'
                           WHEN user_agent ~ 'Android' THEN 'android'
                           ELSE 'other' END AS platform, client
                 FROM devices WHERE user_sub = x.user_sub
             ) d ON true
            WHERE x.revoked_at IS NULL
            GROUP BY x.source_id`
        ),
        pool.query(
          `SELECT source_id, min(day) AS since,
                  sum(created)::int AS created, sum(linked)::int AS linked,
                  sum(tried_expired)::int AS tried_expired, sum(unused)::int AS unused,
                  sum(replaced)::int AS replaced
             FROM link_code_stats GROUP BY source_id`
        ),
      ]);
      const bySource = (list) => new Map(list.map(({ source_id, ...rest }) => [source_id, rest]));
      const platformsBySource = bySource(platforms);
      const statsBySource = bySource(stats);
      res.json({
        sources: rows.map((row) => ({
          ...row,
          platforms: platformsBySource.get(row.id) ?? null,
          link_stats: statsBySource.get(row.id) ?? null,
        })),
      });
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

  // Who an announcement would reach now, before any text is written.
  router.get("/api/admin/announcements/audience", async (req, res, next) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!ANNOUNCEMENT_KEY.test(key)) return res.status(400).json(bad("key", "bad_key"));
    try {
      const { rows } = await pool.query(ANDROID_WITHOUT_APP, [key]);
      res.json({ audience: countAudience(rows, null) });
    } catch (err) {
      next(err);
    }
  });

  // With dry_run, the audience and the messages as each reader gets them, and
  // nothing sent. Without, each account due gets its message, once.
  router.post("/api/admin/announcements", requireSameOrigin, async (req, res, next) => {
    const parsed = readAnnouncement(req.body ?? {});
    if (parsed.error) return res.status(400).json(parsed.error);
    const { key, url, texts, sourceId } = parsed.value;
    try {
      const { rows: sources } = await pool.query("SELECT id, name FROM sources WHERE id = $1", [sourceId]);
      if (!sources.length) return res.status(400).json(bad("source_id", "no_such_source"));
      const source = sources[0];
      const { rows } = await pool.query(ANDROID_WITHOUT_APP, [key]);
      const audience = countAudience(rows, texts);
      const messages = { he: texts.he, en: texts.en, ...(texts.anonymous ? { anonymous: texts.anonymous } : {}) };
      if (req.body.dry_run) return res.json({ dry_run: true, source, url, audience, messages });

      let sent = 0;
      let devices = 0;
      for (const user of rows) {
        const text = !user.sent && textFor(user, texts);
        if (!text) continue;
        const at = Date.now();
        const id = ulid(at);
        const result = await withTx(pool, async (client) => {
          // Claimed first, in the same transaction: a second press running
          // alongside waits here, then finds it taken.
          const claimed = await client.query(
            "INSERT INTO announcement_sends (announcement, user_sub) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [key, user.sub]
          );
          if (!claimed.rowCount) return null;
          return insertAndFanOut(client, {
            createdAt: new Date(at),
            id,
            userSub: user.sub,
            source: source.name,
            sourceId: source.id,
            title: text.title,
            body: text.body,
            url,
            kind: "announcement",
            lang: text.lang,
          });
        });
        if (result === null) continue;
        sent++;
        devices += result;
      }
      console.log(JSON.stringify({ msg: "announcement_sent", key, source: source.id, sent, devices }));
      res.json({ sent, devices, audience });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
