import { createHmac, timingSafeEqual } from "node:crypto";

// Truncated to 132 bits. This authenticates a delivery receipt, not a
// credential, and every byte here comes out of a ~3993-byte push budget.
const LENGTH = 22;

export function signAck(notificationId, deviceId) {
  return createHmac("sha256", process.env.ACK_SECRET)
    .update(`${notificationId}.${deviceId}`)
    .digest("base64url")
    .slice(0, LENGTH);
}

export function verifyAck(notificationId, deviceId, presented) {
  if (typeof presented !== "string" || presented.length !== LENGTH) return false;
  const expected = Buffer.from(signAck(notificationId, deviceId));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
