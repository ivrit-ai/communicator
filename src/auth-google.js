import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

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

// The app's own sessions: issued by the app's server for a Google account it
// verified, lasting months where Google's tokens last an hour. Accepted when
// APP_TOKEN_ISSUER (the app's origin, e.g. https://app.ivrit.ai) is set; their
// keys are at APP_TOKEN_JWKS_URL (default: its /.well-known/jwks.json).
const APP_ISSUER = (process.env.APP_TOKEN_ISSUER ?? "").replace(/\/+$/, "");
const APP_JWKS_URL = process.env.APP_TOKEN_JWKS_URL || (APP_ISSUER && `${APP_ISSUER}/.well-known/jwks.json`);
const APP_AUDIENCE = "ivrit-app";

// Cached and refreshed by jose itself, as with the platform's keys.
let jwks = null;
let appJwks = null;

// A bearer value shaped like a JWT. Ingest tokens and source keys, which also
// arrive as Bearer on their own routes, have no dots.
export function bearerJwt(req) {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token.split(".").length === 3 ? token : null;
}

// The Google account behind a token (Google's own, or an app session naming
// one), or null if it is not one we accept.
export async function verifyGoogleToken(token) {
  if (!token) return null;
  let issuer = null;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    return null;
  }
  if (APP_ISSUER && issuer === APP_ISSUER) return verifyAppSession(token);
  if (!CLIENT_IDS.length) return null;
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

async function verifyAppSession(token) {
  appJwks ??= createRemoteJWKSet(new URL(APP_JWKS_URL));
  try {
    const { payload } = await jwtVerify(token, appJwks, {
      issuer: APP_ISSUER,
      audience: APP_AUDIENCE,
      algorithms: ["RS256"],
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "email"],
    });
    // The app's server issues these only for a Google account with a verified
    // address (see the ivrit.ai app's session.js), so the address stands.
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      name: payload.name ? String(payload.name) : null,
      exp: payload.exp,
    };
  } catch (err) {
    console.warn(JSON.stringify({ msg: "app_session_rejected", err: String(err.code ?? err) }));
    return null;
  }
}
