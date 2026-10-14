import { test } from "node:test";
import assert from "node:assert/strict";
import { s256, verifierMatches } from "./pkce";

// docs/MCP.md §21, Testing — PKCE against RFC 7636's own example (Appendix B).

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("S256 of RFC 7636's verifier is its challenge", () => {
  assert.equal(s256(RFC_VERIFIER), RFC_CHALLENGE);
  assert.equal(verifierMatches(RFC_VERIFIER, RFC_CHALLENGE), true);
});

test("a verifier that doesn't hash to the challenge is refused", () => {
  assert.equal(verifierMatches(`${RFC_VERIFIER.slice(0, -1)}l`, RFC_CHALLENGE), false);
});

test("a verifier outside RFC 7636's grammar is refused, even one that hashes right", () => {
  const short = "a".repeat(42);
  assert.equal(verifierMatches(short, s256(short)), false);
  const long = "a".repeat(129);
  assert.equal(verifierMatches(long, s256(long)), false);
  const spaced = `${"a".repeat(42)} `;
  assert.equal(verifierMatches(spaced, s256(spaced)), false);
});

test("the challenge itself is not a verifier for itself", () => {
  // `plain` would accept this; S256 doesn't.
  assert.equal(verifierMatches(RFC_CHALLENGE, RFC_CHALLENGE), false);
});
