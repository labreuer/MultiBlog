import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIpFromHeaders } from "./client-ip";

// docs/COMMENTS.md, "Identities kept apart" — the address nginx saw, never
// one a client wrote.

function from(headers: Record<string, string>) {
  return clientIpFromHeaders((name) => headers[name] ?? null);
}

test("X-Real-IP wins over X-Forwarded-For", () => {
  assert.equal(from({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 203.0.113.7" }), "203.0.113.7");
});

test("a forged first X-Forwarded-For entry is not taken", () => {
  // The client sent "6.6.6.6"; nginx appended the peer it saw.
  assert.equal(from({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), "203.0.113.7");
});

test("a single X-Forwarded-For entry is the one taken", () => {
  assert.equal(from({ "x-forwarded-for": "::1" }), "::1");
});

test("entries are trimmed, and empty ones skipped", () => {
  assert.equal(from({ "x-forwarded-for": " 6.6.6.6 ,203.0.113.7 , " }), "203.0.113.7");
  assert.equal(from({ "x-real-ip": "  ", "x-forwarded-for": "203.0.113.7" }), "203.0.113.7");
});

test("neither header is null", () => {
  assert.equal(from({}), null);
  assert.equal(from({ "x-forwarded-for": " , " }), null);
});
