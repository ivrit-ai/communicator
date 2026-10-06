import { createCipheriv, createSign, randomBytes } from "node:crypto";

// Firebase Cloud Messaging, for the ivrit.ai app on Android, whose devices are
// reached through Firebase rather than web push. Configured by a service
// account (FCM_SERVICE_ACCOUNT, the JSON key file's contents); without it,
// Firebase devices can neither register nor be sent to.
//
// Web push is encrypted end to end by the protocol. Firebase is not: Google
// would read every message it relays. So each app device registers its own
// AES-256 key, and the message travels as a single opaque field the app
// decrypts.

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const API_BASE = process.env.FCM_API_BASE || "https://fcm.googleapis.com";

let account = null;
try {
  account = process.env.FCM_SERVICE_ACCOUNT ? JSON.parse(process.env.FCM_SERVICE_ACCOUNT) : null;
} catch {
  console.error(JSON.stringify({ msg: "fcm_service_account_unreadable" }));
}

export const fcmConfigured = () => Boolean(account?.client_email && account?.private_key && account?.project_id);

let cached = null;

// An OAuth access token, minted from the service account and reused until
// shortly before it expires.
async function accessToken() {
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
  const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: account.client_email,
    scope: SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url")}`;
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw Object.assign(new Error(`fcm_token_${res.status}`), { statusCode: 401 });
  const body = await res.json();
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

// AES-256-GCM: a fresh 12-byte nonce, then the ciphertext with its 16-byte tag
// appended, which is the layout Android's "AES/GCM/NoPadding" reads.
export function sealFor(secret, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

// Sends one message. Resolves with the HTTP status on success; rejects with an
// error carrying statusCode, headers and Firebase's error code otherwise, the
// same shape the sender already handles for web push.
export async function sendFcm({ token, secret, payload, ttlSeconds }) {
  const res = await fetch(`${API_BASE}/v1/projects/${account.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        // Data only, never a "notification" block: the app shows it itself,
        // after decrypting, in its own high-importance channel.
        data: { p: sealFor(secret, payload) },
        android: { priority: "HIGH", ttl: `${ttlSeconds}s` },
      },
    }),
  });
  if (res.ok) return res.status;
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode ?? body?.error?.status ?? null;
  if (res.status === 401) cached = null;
  throw Object.assign(new Error(code ?? `fcm_${res.status}`), {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers),
    code,
    body: JSON.stringify(body?.error ?? body).slice(0, 300),
  });
}

// Firebase's word for a token that will never work again. INVALID_ARGUMENT is
// not counted: it also means a message of ours was malformed, and deleting a
// working device over our own bug would be far worse than one failed send.
export const tokenGone = (err) => err.statusCode === 404 || err.code === "UNREGISTERED";

// Firebase caps a data message at 4096 bytes. Base64 of the sealed payload is
// 4/3 of it plus 28 bytes of nonce and tag, so the plaintext budget is smaller
// than web push's.
export const FCM_MAX_PAYLOAD_BYTES = 2900;
