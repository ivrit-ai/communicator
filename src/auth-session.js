import { createHash, randomBytes } from "node:crypto";
import { readCookie } from "./cookies.js";
import { trustedHost } from "./auth-platform.js";

const SESSION_COOKIE = "__Host-notifier_sess";
const TTL_DAYS = 90;

// Sliding expiry, rate-limited. Extending on every request would turn the
// hottest read path in the app into a write; an hour of drift on a 90-day
// window is irrelevant.
const SLIDE_AFTER = "1 hour";

// The token is 256 bits of CSPRNG output, so a plain digest is enough: there is
// no low-entropy input to grind, and a database dump yields nothing usable.
function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

function cookieAttributes(maxAgeSeconds) {
  // __Host- requires Secure and Path=/ with no Domain, which also pins the
  // cookie to this exact origin. SameSite=Lax so the post-OAuth top-level
  // redirect back from the platform still carries it.
  return `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export async function createSession(client, userSub, userAgent) {
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO sessions (token_hash, user_sub, expires_at, user_agent)
     VALUES ($1, $2, now() + $3::interval, $4)`,
    [hashToken(token), userSub, `${TTL_DAYS} days`, userAgent?.slice(0, 500) ?? null]
  );
  return token;
}

export function setSessionCookie(res, token) {
  res.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; ${cookieAttributes(TTL_DAYS * 86400)}`
  );
}

export function clearSessionCookie(res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttributes(0)}`);
}

export async function destroySession(pool, req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

async function lookup(pool, token) {
  // One round trip: the lookup and the conditional slide would otherwise be two
  // queries on every authenticated request.
  const { rows } = await pool.query(
    `WITH found AS (
       SELECT s.token_hash, s.last_seen_at, u.sub, u.email, u.name
         FROM sessions s
         JOIN users u ON u.sub = s.user_sub
        WHERE s.token_hash = $1 AND s.expires_at > now()
     ), slid AS (
       UPDATE sessions
          SET last_seen_at = now(), expires_at = now() + $2::interval
        WHERE token_hash = (
                SELECT token_hash FROM found
                 WHERE last_seen_at < now() - $3::interval
              )
     )
     SELECT sub, email, name FROM found`,
    [hashToken(token), `${TTL_DAYS} days`, SLIDE_AFTER]
  );
  return rows[0] ?? null;
}

export function requireSession(pool) {
  return async (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return res.status(401).json({ error: "unauthenticated" });
    try {
      const user = await lookup(pool, token);
      if (!user) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "unauthenticated" });
      }
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// SameSite=Lax already blocks cross-site POSTs from a form navigation, but not
// every browser in the field enforces it the same way. Checking Origin costs
// nothing and fails closed.
export function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return res.status(403).json({ error: "origin_required" });
  let originHost;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return res.status(403).json({ error: "bad_origin" });
  }
  if (originHost !== trustedHost(req)) {
    return res.status(403).json({ error: "bad_origin" });
  }
  next();
}
