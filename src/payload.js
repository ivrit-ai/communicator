import { signAck } from "./ack.js";

// Push services reject anything over ~4KB of ciphertext. Trimming here turns a
// wasted round trip plus a 413 into a notification that simply arrives.
export const MAX_PAYLOAD_BYTES = 3800;

// Single-character keys: the envelope would otherwise burn ~60 bytes of a
// genuinely tight budget. The content travels inside the encrypted push rather
// than a tickle-and-fetch, because a fetch from the service worker would carry
// a possibly-expired cookie and degrade to a useless placeholder. A body too
// long to fit goes as a preview marked x=1; the service worker's ack fetches
// the rest.

// Cut to at most maxBytes of UTF-8 without splitting a character.
function truncateBytes(text, maxBytes) {
  const buf = Buffer.from(text);
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString();
}

export function buildPayload(row, { stub = false, maxBytes = MAX_PAYLOAD_BYTES } = {}) {
  const payload = {
    i: row.notification_id,
    d: String(row.device_id),
    k: signAck(row.notification_id, row.device_id),
    s: row.source,
    t: row.title,
    ts: new Date(row.created_at).getTime(),
  };
  if (row.source_id) payload.sid = row.source_id;
  if (row.subtitle) payload.st = row.subtitle;
  if (row.lang) payload.l = row.lang;
  if (stub) {
    if (row.body) payload.x = 1;
  } else {
    if (row.body) payload.b = row.body;
    if (row.url) payload.u = row.url;
  }

  let encoded = JSON.stringify(payload);
  if (!stub && payload.b && Buffer.byteLength(encoded) > maxBytes) {
    payload.x = 1;
    // JSON escaping can make the encoded body longer than the text itself, so
    // measure the result rather than trusting the arithmetic once.
    let budget = Buffer.byteLength(payload.b) - (Buffer.byteLength(JSON.stringify(payload)) - maxBytes) - 3;
    for (;;) {
      payload.b = truncateBytes(row.body, budget) + "…";
      encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded) <= maxBytes || budget <= 0) break;
      budget -= Buffer.byteLength(encoded) - maxBytes;
    }
  }
  return encoded;
}
