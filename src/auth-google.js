import { createRemoteJWKSet, jwtVerify } from "jose";

// Google ID tokens, from apps that sign in with Google themselves rather than
// through this site's login: the ivrit.ai Android app, which signs in on the
// phone with transcribe.ivrit.ai's OAuth client and sends the token Google
// issued it as `Authorization: Bearer`. Accepted for the client ids in
// APP_GOOGLE_CLIENT_IDS; unset, such tokens are refused.
//
// Read lazily-tolerant, like EXPECTED_HOSTS: ES module bodies run before
// server.js validates env.
const CLIENT_IDS = (process.env.APP_GOOGLE_CLIENT_IDS ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const JWKS_URL = process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Cached and refreshed by jose itself, as with the platform's keys.
let jwks = null;

// A bearer value shaped like a JWT. Ingest tokens and source keys, which also
// arrive as Bearer on their own routes, have no dots.
export function bearerJwt(req) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.split(".").length === 3 ? token : null;
}

// The Google account behind a token, or null if it is not one we accept.
export async function verifyGoogleToken(token) {
  if (!CLIENT_IDS.length || !token) return null;
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUERS,
      audience: CLIENT_IDS,
      algorithms: ["RS256"],
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iat", "email"],
    });
    // Accounts are found by email when the Google id is new here (see
    // auth-session.js), so the address must be one Google vouches for.
    if (payload.email_verified !== true) return null;
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      name: payload.name ? String(payload.name) : null,
      exp: payload.exp,
    };
  } catch (err) {
    console.warn(JSON.stringify({ msg: "google_token_rejected", err: String(err.code ?? err) }));
    return null;
  }
}
