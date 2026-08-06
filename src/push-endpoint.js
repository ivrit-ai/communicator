import { createHash } from "node:crypto";

// The sender POSTs to whatever endpoint is stored here, so an unvalidated value
// is a server-side request forgery primitive: any signed-in user could point it
// at the container's own network. Push endpoints only ever come from a browser's
// push service, which is a small known set, so an allowlist is the right shape.
// Add a suffix here when a new browser ships its own service.
const ALLOWED_SUFFIXES = [
  "fcm.googleapis.com", // Chrome, Edge, and other Chromium browsers
  ".push.services.mozilla.com", // Firefox
  ".push.apple.com", // Safari
  ".notify.windows.com", // WNS
];

const MAX_ENDPOINT = 2000;
const MAX_KEY = 200;

export function hashEndpoint(endpoint) {
  return createHash("sha256").update(endpoint).digest();
}

// Returns an error string, or null when the subscription is usable.
export function validateSubscription({ endpoint, p256dh, auth }) {
  if (typeof endpoint !== "string" || !endpoint) return "endpoint_required";
  if (Buffer.byteLength(endpoint) > MAX_ENDPOINT) return "endpoint_too_long";

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return "endpoint_malformed";
  }
  if (url.protocol !== "https:") return "endpoint_not_https";

  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_SUFFIXES.some((s) =>
    s.startsWith(".") ? host.endsWith(s) : host === s
  );
  if (!allowed) return "endpoint_host_not_allowed";

  for (const [name, value] of [
    ["p256dh", p256dh],
    ["auth", auth],
  ]) {
    if (typeof value !== "string" || !value) return `${name}_required`;
    if (Buffer.byteLength(value) > MAX_KEY) return `${name}_too_long`;
    // These are transported as base64url in the Web Push spec; anything else
    // would fail inside the encryption step much later, with a worse error.
    if (!/^[A-Za-z0-9_-]+=*$/.test(value)) return `${name}_malformed`;
  }

  return null;
}
