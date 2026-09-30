import { createHash, randomBytes } from "node:crypto";

// Crockford base32: no I, L, O or U, so a code survives being read aloud or
// retyped. Ten characters (50 bits), where Eliezer's own Telegram codes use
// eight, so a source can tell the two apart by length alone.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 10;

export const CODE_TTL_MINUTES = 15;

export function generateCode() {
  const bytes = randomBytes(LENGTH);
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b & 31];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

// Whatever the user typed, as the ten canonical characters: case, spacing and
// the dash do not matter, and the letters Crockford leaves out read as the
// digits they look like.
export function normalizeCode(input) {
  if (typeof input !== "string") return null;
  const raw = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (raw.length !== LENGTH) return null;
  for (const c of raw) if (!ALPHABET.includes(c)) return null;
  return raw;
}

// 50 bits, single use, alive for 15 minutes, and only a registered source can
// try one: a plain digest is enough to keep the table from being a list of
// live codes.
export function hashCode(normalized) {
  return createHash("sha256").update(`link:${normalized}`).digest();
}
