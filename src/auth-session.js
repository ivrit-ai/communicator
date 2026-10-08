import { createHash, randomBytes } from "node:crypto";
import { readCookie } from "./cookies.js";
import { trustedHost } from "./auth-platform.js";
import { allowedAppOrigin } from "./cors.js";
import { bearerJwt, verifyGoogleToken } from "./auth-google.js";

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
       SELECT s.token_hash, s.last_seen_at, u.sub, u.email, u.name, u.kind, u.locale
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
     SELECT sub, email, name, kind, locale FROM found`,
    [hashToken(token), `${TTL_DAYS} days`, SLIDE_AFTER]
  );
  return rows[0] ?? null;
}

// --- Google ID tokens (see auth-google.js)
//
// An app that signs in with Google itself sends the token on every request, so
// verified tokens are kept until they expire rather than checked each time.
const MAX_CACHED = 2000;
const tokenUsers = new Map();

// The user a Google account maps to, made on first sight. The account was
// perhaps first seen through this site's login, whose identity is also Google's
// but may carry a different id, so a new Google id is matched to an existing
// Google user by its verified email, and remembered.
async function googleUser(pool, identity) {
  const columns = "sub, email, name, kind, locale";
  let { rows } = await pool.query(
    `UPDATE users SET email = $2, name = COALESCE($3, name), last_seen_at = now()
      WHERE sub = (SELECT sub FROM users WHERE google_sub = $1 OR sub = $1
                    ORDER BY (google_sub = $1) DESC NULLS LAST LIMIT 1)
      RETURNING ${columns}`,
    [identity.sub, identity.email, identity.name]
  );
  if (rows[0]) return rows[0];
  ({ rows } = await pool.query(
    `UPDATE users SET google_sub = $1, name = COALESCE(name, $3), last_seen_at = now()
      WHERE sub = (SELECT sub FROM users WHERE kind = 'google' AND google_sub IS NULL
                    AND lower(email) = lower($2) ORDER BY created_at LIMIT 1)
      RETURNING ${columns}`,
    [identity.sub, identity.email, identity.name]
  ));
  if (rows[0]) return rows[0];
  ({ rows } = await pool.query(
    `INSERT INTO users (sub, email, name, kind, google_sub) VALUES ($1, $2, $3, 'google', $1)
     ON CONFLICT (sub) DO UPDATE SET last_seen_at = now()
     RETURNING ${columns}`,
    [identity.sub, identity.email, identity.name]
  ));
  return rows[0];
}

async function bearerUser(pool, token) {
  const hit = tokenUsers.get(token);
  if (hit && hit.exp * 1000 > Date.now()) return hit.user;
  const identity = await verifyGoogleToken(token);
  if (!identity) return null;
  const user = await googleUser(pool, identity);
  if (tokenUsers.size >= MAX_CACHED) tokenUsers.delete(tokenUsers.keys().next().value);
  tokenUsers.set(token, { user, exp: identity.exp });
  return user;
}

// A deleted account must not live on in the cache.
export function forgetCachedUser(sub) {
  for (const [token, { user }] of tokenUsers) if (user.sub === sub) tokenUsers.delete(token);
}

// The signed-in user if there is one, else null. For routes that behave
// differently for a returning visitor but must also serve a new one.
export async function currentUser(pool, req) {
  const jwt = bearerJwt(req);
  if (jwt) return bearerUser(pool, jwt);
  const token = readCookie(req, SESSION_COOKIE);
  return token ? lookup(pool, token) : null;
}

export function requireSession(pool) {
  return async (req, res, next) => {
    const jwt = bearerJwt(req);
    if (jwt) {
      try {
        const user = await bearerUser(pool, jwt);
        if (!user) return res.status(401).json({ error: "invalid_token" });
        req.user = user;
        return next();
      } catch (err) {
        return next(err);
      }
    }
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
  // A bearer token is not sent by the browser on its own, so a request carrying
  // one cannot be forged by another site; whether it is valid is requireSession's
  // job.
  if (bearerJwt(req)) return next();
  const origin = req.get("origin");
  if (!origin) return res.status(403).json({ error: "origin_required" });
  // Other ivrit.ai apps acting for the signed-in user (see cors.js).
  if (allowedAppOrigin(origin)) return next();
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

// Read lazily-tolerant, like EXPECTED_HOSTS: an unset list simply means nobody
// is an admin.
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

// Only a Google account can be an admin: the email on an anonymous account is
// null, and nothing else vouches for who is holding the cookie.
export function isAdmin(user) {
  return Boolean(user?.kind === "google" && user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
}

// Mounted after requireSession.
export function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}
