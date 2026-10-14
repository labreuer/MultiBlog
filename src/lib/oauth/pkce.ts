import { createHash, timingSafeEqual } from "node:crypto";

// docs/MCP.md §21 — PKCE (RFC 7636), the proof that whoever redeems a code is
// whoever asked for it. Every client is public, so this is the only proof
// there is. S256 alone: `plain` would make the challenge the secret.

/** A verifier is 43 to 128 unreserved characters (RFC 7636 §4.1). */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** An S256 challenge is a SHA-256 in base64url without padding: 43 characters. */
export const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Whether `verifier` is well formed and hashes to `challenge`. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const actual = Buffer.from(s256(verifier));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
