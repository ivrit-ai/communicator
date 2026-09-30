import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// nsrc_<source id>_<secret>. Source ids are slugs without underscores, so the
// first underscore after the id is unambiguous even though the secret may
// contain more.
export const SOURCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const WIRE = /^nsrc_([a-z0-9-]{1,32})_([A-Za-z0-9_-]{43})$/;

// Same reasoning as the ingest token cache: bounded, short-lived, and evicted
// explicitly when an admin changes the source.
const CACHE_MAX = 1_000;
const CACHE_TTL_MS = 60_000;
const cache = new Map();

function hashSecret(secret) {
  return createHash("sha256").update(secret).digest();
}

export function generateSourceKey(sourceId) {
  const secret = randomBytes(32).toString("base64url");
  const wire = `nsrc_${sourceId}_${secret}`;
  // Enough to recognise which key is deployed where, never enough to use it.
  return { wire, keyHash: hashSecret(secret), keyPrefix: `nsrc_${sourceId}_${secret.slice(0, 4)}` };
}

export function evictSource(sourceId) {
  cache.delete(sourceId);
}

async function load(pool, sourceId) {
  const cached = cache.get(sourceId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const { rows } = await pool.query(
    "SELECT id, name, key_hash, rate_per_minute, enabled FROM sources WHERE id = $1",
    [sourceId]
  );
  const entry = rows[0]
    ? {
        found: true,
        id: rows[0].id,
        name: rows[0].name,
        keyHash: rows[0].key_hash,
        perMinute: rows[0].rate_per_minute,
        enabled: rows[0].enabled,
      }
    : { found: false };
  cache.delete(sourceId);
  cache.set(sourceId, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry;
}

// Machine to machine, like ingest: never reads cookies.
export function requireSourceKey(pool) {
  return async (req, res, next) => {
    const header = req.get("authorization");
    const m = header?.startsWith("Bearer ") ? WIRE.exec(header.slice(7).trim()) : null;
    if (!m) return res.status(401).json({ error: "missing_or_malformed_key" });
    try {
      const source = await load(pool, m[1]);
      const presented = hashSecret(m[2]);
      if (
        !source.found ||
        presented.length !== source.keyHash.length ||
        !timingSafeEqual(presented, source.keyHash)
      ) {
        return res.status(401).json({ error: "invalid_key" });
      }
      if (!source.enabled) return res.status(403).json({ error: "source_disabled" });
      req.source = { id: source.id, name: source.name, perMinute: source.perMinute };
      next();
    } catch (err) {
      next(err);
    }
  };
}
