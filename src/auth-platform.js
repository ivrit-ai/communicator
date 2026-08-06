import { createRemoteJWKSet, jwtVerify } from "jose";
import { readCookie } from "./cookies.js";

const ISSUER = "https://auth.xhostd.com";
const PLATFORM_COOKIE = "__Host-xhost_id";

// Cached and refreshed by jose itself; constructing this per request would hit
// the JWKS endpoint on every sign-in.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/xhost-auth/jwks`));

// Read lazily-tolerant: ES module bodies run before server.js validates env, so
// a missing value must not throw here and pre-empt the clear FATAL message.
const EXPECTED_HOSTS = new Set(
  (process.env.EXPECTED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

// The platform mints one JWT per channel hostname, so `aud` is only meaningful
// once the hostname itself is trusted. Without this allowlist an attacker could
// present a valid token minted for *their* xhost app together with a forged
// Host header and have us verify it against itself.
export function trustedHost(req) {
  const host = req.hostname?.toLowerCase();
  return host && EXPECTED_HOSTS.has(host) ? host : null;
}

export async function verifyPlatformIdentity(req) {
  const token = readCookie(req, PLATFORM_COOKIE);
  if (!token) return null;

  const host = trustedHost(req);
  if (!host) {
    console.error(JSON.stringify({ msg: "untrusted_host", host: req.hostname }));
    return null;
  }

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ISSUER,
    audience: host,
    algorithms: ["RS256"],
    clockTolerance: 60,
    requiredClaims: ["exp", "iss", "aud", "sub", "email"],
  });

  return {
    sub: String(payload.sub),
    email: String(payload.email),
    name: payload.name ? String(payload.name) : null,
  };
}
