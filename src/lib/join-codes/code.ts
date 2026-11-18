import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// docs/EMAIL.md §10, "The code". A card's code is derived, not stored: the
// first 80 bits of HMAC-SHA256(K, "<batch id>:<serial>"), written as 16
// Crockford base32 characters. The row keeps only the code's SHA-256, for the
// lookup; a lookup then re-derives the code from the row under the current
// key and compares, so a card does not outlive the key it was made with.
//
// Pure functions over node:crypto: no Prisma and nothing Next-specific, so
// the mint script, the Route Handler that prints a sheet and the unit tests
// all call the same code.

// Crockford's alphabet: the digits and the letters less I, L, O and U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const JOIN_CODE_LENGTH = 16; // 16 × 5 bits = 80 bits
const CODE_BYTES = 10; // the 80 bits taken from the front of the HMAC
const GROUP = 4;

// HKDF's info: what this key is for. A second use of AUTH_SECRET gets a label
// of its own, so no key derived for it can be one of these. "v1" is bumped
// only to void every card at once without touching AUTH_SECRET.
const KEY_INFO = "multiblog join codes v1";

const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** The join-code key, derived from a secret (AUTH_SECRET in use) by HKDF-SHA256. */
export function deriveJoinKey(secret: string): Buffer {
  if (secret.length === 0) throw new Error("The secret is empty.");
  // No salt: the secret is already uniformly random, and the label is what
  // separates this key from any other derived from it.
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 32));
}

function message(batchId: string, serial: number): string {
  if (batchId.length === 0) throw new Error("The batch id is empty.");
  if (!Number.isSafeInteger(serial) || serial < 1) {
    throw new Error(`A serial is a positive integer, not ${serial}.`);
  }
  // Unambiguous whatever the id holds: the serial is everything after the
  // last colon, and it is digits only.
  return `${batchId}:${serial}`;
}

function base32(bytes: Buffer): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  // 80 bits is a whole number of 5-bit characters, so nothing is left over.
  return out;
}

/** A card's code, canonical: 16 Crockford characters, uppercase, no dashes. */
export function deriveJoinCode(key: Buffer, batchId: string, serial: number): string {
  const mac = createHmac("sha256", key).update(message(batchId, serial), "utf8").digest();
  return base32(mac.subarray(0, CODE_BYTES));
}

function assertCanonical(code: string): void {
  if (!CANONICAL.test(code)) {
    throw new Error("Not a canonical join code; pass it through normalizeJoinCode first.");
  }
}

/**
 * The SHA-256 of a canonical code, as hex: what `join_code.code_hash` holds.
 * Throws on any other form, since the hash of a dashed or lowercase code
 * matches no row and would fail no check.
 */
export function hashJoinCode(code: string): string {
  assertCanonical(code);
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Typed or scanned input to a canonical code, or null. Case is ignored,
 * dashes and whitespace dropped, O read as 0, and I and L as 1, as Crockford
 * intends; anything else outside the alphabet (U among it) is refused, and so
 * is anything not 16 characters after that.
 */
export function normalizeJoinCode(input: string): string | null {
  const code = input
    .toUpperCase()
    // ASCII hyphen, the Unicode hyphens and dashes a phone's keyboard may
    // substitute, and any whitespace.
    .replace(/[\s‐-―-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return CANONICAL.test(code) ? code : null;
}

/** A canonical code as printed: `K7Q4-M2XD-9PFA-3HTN`. */
export function formatJoinCode(code: string): string {
  assertCanonical(code);
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) groups.push(code.slice(i, i + GROUP));
  return groups.join("-");
}

/**
 * Whether a canonical code is the one this batch and serial derive under this
 * key, compared in constant time. A row found by its hash is still checked
 * here: the hash survives a rotated key, the derivation does not.
 */
export function joinCodeMatches(
  key: Buffer,
  batchId: string,
  serial: number,
  code: string,
): boolean {
  if (!CANONICAL.test(code)) return false;
  const expected = Buffer.from(deriveJoinCode(key, batchId, serial), "utf8");
  const given = Buffer.from(code, "utf8");
  // Both are 16 ASCII bytes here, which timingSafeEqual requires.
  return timingSafeEqual(expected, given);
}

/** The URL a card's QR holds: `<origin>/join/<code>`, without the dashes. */
export function joinUrl(origin: string, code: string): string {
  assertCanonical(code);
  return `${new URL(origin).origin}/join/${code}`;
}
