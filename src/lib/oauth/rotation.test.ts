import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_WINDOW_MS, hasLapsed, rotationVerdict, type RefreshState } from "./rotation";

// docs/MCP.md §21, Testing — the rotation, as a function of a row's state.

const NOW = Date.parse("2026-10-14T20:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const state = (overrides: Partial<RefreshState>): RefreshState => ({ usedAt: null, childUsed: false, siblingUsed: false, ...overrides });

test("a fresh token is rotated", () => {
  assert.equal(rotationVerdict(state({}), NOW), "rotate");
});

test("a token rotated within two minutes, with none of its children spent, is answered again", () => {
  assert.equal(rotationVerdict(state({ usedAt: ago(5_000) }), NOW), "retry");
  assert.equal(rotationVerdict(state({ usedAt: ago(RETRY_WINDOW_MS) }), NOW), "retry");
});

test("a token rotated within two minutes, with a child spent, is a replay", () => {
  assert.equal(rotationVerdict(state({ usedAt: ago(5_000), childUsed: true }), NOW), "replay");
});

test("a token rotated more than two minutes ago is a replay", () => {
  assert.equal(rotationVerdict(state({ usedAt: ago(RETRY_WINDOW_MS + 1) }), NOW), "replay");
  assert.equal(rotationVerdict(state({ usedAt: ago(24 * 60 * 60_000) }), NOW), "replay");
});

test("a token retired by its sibling's use is a replay, never yet rotated or not", () => {
  assert.equal(rotationVerdict(state({ siblingUsed: true }), NOW), "replay");
  assert.equal(rotationVerdict(state({ usedAt: ago(5_000), siblingUsed: true }), NOW), "replay");
});

test("a connection lapses when its newest refresh token passes its expiry, and one with none has lapsed", () => {
  const now = new Date(NOW);
  assert.equal(hasLapsed([{ expiresAt: new Date(NOW + 1) }], now), false);
  assert.equal(hasLapsed([{ expiresAt: now }], now), true);
  assert.equal(hasLapsed([], now), true);
});
