import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenState, type TokenStateRow } from "./token-state";

// docs/MCP.md §21, "Seeing and ending a connection" — what the Connections
// card and the script's --list say of a row.

const NOW = new Date("2026-10-15T20:00:00Z");
const later = new Date(NOW.getTime() + 60_000);
const earlier = new Date(NOW.getTime() - 60_000);
const header = (overrides: Partial<TokenStateRow>): TokenStateRow => ({
  oauthClientId: null,
  expiresAt: later,
  revokedAt: null,
  refreshTokens: [],
  ...overrides,
});
const connection = (overrides: Partial<TokenStateRow>): TokenStateRow => ({
  oauthClientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  expiresAt: null,
  revokedAt: null,
  refreshTokens: [{ expiresAt: later }],
  ...overrides,
});

test("a header token is live until its expiry, and expired from it", () => {
  assert.deepEqual(tokenState(header({}), NOW), { kind: "live" });
  assert.deepEqual(tokenState(header({ expiresAt: NOW }), NOW), { kind: "expired", at: NOW });
});

test("a connection is live while its newest refresh token is, and lapsed from that token's expiry", () => {
  assert.deepEqual(tokenState(connection({}), NOW), { kind: "live" });
  assert.deepEqual(tokenState(connection({ refreshTokens: [{ expiresAt: earlier }] }), NOW), { kind: "lapsed", at: earlier });
  assert.deepEqual(tokenState(connection({ refreshTokens: [] }), NOW), { kind: "lapsed", at: null });
});

test("a revocation outranks an expiry and a lapse", () => {
  assert.deepEqual(tokenState(header({ expiresAt: earlier, revokedAt: earlier }), NOW), { kind: "revoked", at: earlier });
  assert.deepEqual(tokenState(connection({ refreshTokens: [], revokedAt: earlier }), NOW), { kind: "revoked", at: earlier });
});
