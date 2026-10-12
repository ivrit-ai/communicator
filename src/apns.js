import { createPrivateKey, sign } from "node:crypto";
import http2 from "node:http2";
import { sealFor } from "./fcm.js";

// Apple Push Notification service, for the ivrit.ai app on iPhone. Configured
// by a token-based key from Apple's developer site: APNS_KEY (the .p8 file's
// contents), APNS_KEY_ID and APNS_TEAM_ID; without them, iPhones can neither
// register nor be sent to.
//
// As with Firebase, Apple would read whatever it relays, so the message travels
// sealed with the device's own key (sealFor, the same layout as Android's). An
// iPhone shows a push without running the app, though, so it goes as an alert
// with mutable-content: the app's Notification Service Extension opens the
// sealed field and replaces the alert before it shows. Apple sees only two
// fixed placeholders, which the phone itself shows if the extension cannot.

const TOPIC = process.env.APNS_TOPIC || "ai.ivrit";
const HOSTS = {
  production: process.env.APNS_HOST || "https://api.push.apple.com",
  sandbox: process.env.APNS_SANDBOX_HOST || "https://api.sandbox.push.apple.com",
};
const TIMEOUT_MS = 15_000;
// Apple refuses a provider token older than an hour, and one replaced more
// often than every 20 minutes.
const TOKEN_REFRESH_MS = 40 * 60_000;

let key = null;
try {
  // Accepted with its newlines escaped too, as single-line secret stores keep it.
  key = process.env.APNS_KEY ? createPrivateKey(process.env.APNS_KEY.replace(/\\n/g, "\n")) : null;
} catch {
  console.error(JSON.stringify({ msg: "apns_key_unreadable" }));
}

export const apnsConfigured = () => Boolean(key && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID);

// A device registered from a development build is reached through Apple's
// sandbox, with tokens that production does not know. Its endpoint is stored
// with this prefix; a production device's is the bare token.
const SANDBOX = "sandbox:";
export const apnsEndpoint = (token, environment) => (environment === "sandbox" ? SANDBOX + token : token);

let cached = null;

function providerToken() {
  if (cached && Date.now() - cached.at < TOKEN_REFRESH_MS) return cached.token;
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "ES256", kid: process.env.APNS_KEY_ID })}.${part({
    iss: process.env.APNS_TEAM_ID,
    iat: Math.floor(Date.now() / 1000),
  })}`;
  // JWT's ES256 is the raw r||s pair, not the DER that sign() gives by default.
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  cached = { token: `${unsigned}.${signature}`, at: Date.now() };
  return cached.token;
}

// One HTTP/2 connection per host, kept open: Apple asks providers to reuse
// connections rather than open one per message. A connection that closes or
// fails is dropped, and the next send opens another.
const sessions = new Map();

function session(origin) {
  let s = sessions.get(origin);
  if (s && !s.closed && !s.destroyed) return s;
  s = http2.connect(origin);
  const forget = () => {
    if (sessions.get(origin) === s) sessions.delete(origin);
  };
  s.on("close", forget);
  s.on("goaway", forget);
  s.on("error", forget);
  // An idle connection must not keep the sender alive at shutdown.
  s.unref();
  sessions.set(origin, s);
  return s;
}

// Sends one message to endpoint (as stored: the device token, perhaps with the
// sandbox prefix). Resolves with the HTTP status on success; rejects with an
// error carrying statusCode, headers and Apple's reason otherwise, the same
// shape the sender handles for web push and Firebase.
export function sendApns({ endpoint, secret, payload, ttlSeconds }) {
  const sandbox = endpoint.startsWith(SANDBOX);
  const token = sandbox ? endpoint.slice(SANDBOX.length) : endpoint;
  const body = JSON.stringify({
    aps: { alert: { "title-loc-key": "PUSH_TITLE", "loc-key": "PUSH_BODY" }, "mutable-content": 1, sound: "default" },
    p: sealFor(secret, payload),
  });
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = session(sandbox ? HOSTS.sandbox : HOSTS.production).request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + ttlSeconds),
        "content-type": "application/json",
      });
    } catch (err) {
      reject(Object.assign(new Error(`apns_connect: ${err.message}`), { statusCode: undefined }));
      return;
    }
    let status;
    let headers = {};
    const chunks = [];
    req.setTimeout(TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (h) => {
      status = h[":status"];
      headers = Object.fromEntries(Object.entries(h).filter(([name]) => !name.startsWith(":")));
    });
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (status === 200) return resolve(status);
      const text = Buffer.concat(chunks).toString();
      let reason = null;
      try {
        reason = JSON.parse(text).reason ?? null;
      } catch {}
      // A rejected provider token is replaced on the next send.
      if (status === 403 && /ProviderToken/.test(reason ?? "")) cached = null;
      reject(
        Object.assign(new Error(reason ?? `apns_${status}`), {
          statusCode: status,
          headers,
          code: reason,
          body: text.slice(0, 300),
        })
      );
    });
    req.on("error", (err) => {
      reject(Object.assign(new Error(`apns_stream: ${err.message}`), { statusCode: undefined }));
    });
    // Timed out, or the connection went away mid-request (once settled, a no-op).
    req.on("close", () => reject(Object.assign(new Error("apns_closed"), { statusCode: undefined })));
    req.end(body);
  });
}

// Apple's word for a token that will never work again. BadDeviceToken is not
// counted: it is also what a device registered for the sandbox gets from
// production (and the reverse), so a mistake of ours in the environment would
// delete every working iPhone.
export const apnsTokenGone = (err) => err.statusCode === 410 || err.code === "Unregistered";

// Apple caps an alert's JSON at 4096 bytes. The fixed part (aps and the field
// name) is about 120 bytes; the sealed field is base64 of the plaintext plus 28
// bytes of nonce and tag, so the plaintext may be (4096 - 120) * 3/4 - 28 ≈ 2950.
// Kept a little under, like Firebase's.
export const APNS_MAX_PAYLOAD_BYTES = 2900;
