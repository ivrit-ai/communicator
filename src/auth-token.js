import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "ntfy";
const ID_BYTES = 9; // 12 base64url chars
const SECRET_BYTES = 32; // 43 base64url chars
const WIRE = /^ntfy_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;

// Bounded so a flood of distinct tokens cannot grow the heap without limit.
// Correct only because the web tier is a single process — see the note in the
// architecture plan about why it must stay that way.
const CACHE_MAX = 20_000;
const CACHE_TTL_MS = 5 * 60_000;

// last_used_at is a human-facing "when did this token last fire" field, not an
// audit log. Writing it on every request would add a row update to the hottest
// path in the system for no gain.
const LAST_USED_THROTTLE_MS = 60_000;

const cache = new Map();

function cacheGet(tokenId) {
  const entry = cache.get(tokenId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(tokenId);
    return null;
  }
  // Map preserves insertion order, so re-inserting marks this as most-recent.
  cache.delete(tokenId);
  cache.set(tokenId, entry);
  return entry;
}

function cacheSet(tokenId, entry) {
  cache.delete(tokenId);
  cache.set(tokenId, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function evictToken(tokenId) {
  cache.delete(tokenId);
}

// Plain SHA-256 is the right choice here, not bcrypt/argon2: those exist to
// slow brute force against low-entropy passwords, and this is 256 bits of
// CSPRNG output. There is nothing to grind, and this runs on every ingest.
function hashSecret(secret) {
  return createHash("sha256").update(secret).digest();
}

export function generateToken() {
  const tokenId = randomBytes(ID_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { tokenId, secretHash: hashSecret(secret), wire: `${PREFIX}_${tokenId}_${secret}` };
}

function parseBearer(req) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const m = WIRE.exec(header.slice(7).trim());
  return m ? { tokenId: m[1], secret: m[2] } : null;
}

async function load(pool, tokenId) {
  const { rows } = await pool.query(
    `SELECT secret_hash, user_sub, name FROM ingest_tokens
      WHERE token_id = $1 AND revoked_at IS NULL`,
    [tokenId]
  );
  return rows[0] ?? null;
}

function sameSecret(presented, stored) {
  const a = hashSecret(presented);
  return a.length === stored.length && timingSafeEqual(a, stored);
}

// Deliberately never reads cookies. Ingest is a machine-to-machine path, so
// keeping it on its own middleware chain makes it structurally impossible for
// a CSRF-able credential to authenticate a send.
export function requireIngestToken(pool) {
  return async (req, res, next) => {
    const parsed = parseBearer(req);
    if (!parsed) return res.status(401).json({ error: "missing_or_malformed_token" });

    try {
      let entry = cacheGet(parsed.tokenId);
      if (!entry) {
        const row = await load(pool, parsed.tokenId);
        // Negative results are cached too, or an attacker replaying garbage
        // token ids turns into one database round trip per request.
        entry = row
          ? { found: true, secretHash: row.secret_hash, userSub: row.user_sub, name: row.name }
          : { found: false };
        cacheSet(parsed.tokenId, entry);
      }

      if (!entry.found || !sameSecret(parsed.secret, entry.secretHash)) {
        return res.status(401).json({ error: "invalid_token" });
      }

      const now = Date.now();
      if (!entry.lastUsedWrittenAt || now - entry.lastUsedWrittenAt > LAST_USED_THROTTLE_MS) {
        entry.lastUsedWrittenAt = now;
        pool
          .query("UPDATE ingest_tokens SET last_used_at = now() WHERE token_id = $1", [
            parsed.tokenId,
          ])
          .catch((err) =>
            console.error(JSON.stringify({ msg: "last_used_update_failed", err: String(err) }))
          );
      }

      // The source name comes from the token, never from the request body, so a
      // sender cannot spoof which service a notification claims to be from.
      req.ingest = { tokenId: parsed.tokenId, userSub: entry.userSub, source: entry.name };
      next();
    } catch (err) {
      next(err);
    }
  };
}
