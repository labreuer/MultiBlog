import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJoinExpiry } from "./expiry";

test("a bare date is the end of that day, UTC", () => {
  assert.equal(parseJoinExpiry("2026-12-31")?.toISOString(), "2026-12-31T23:59:59.999Z");
  assert.equal(parseJoinExpiry("  2026-12-31 ")?.toISOString(), "2026-12-31T23:59:59.999Z");
});

test("a date-time is read as given", () => {
  assert.equal(parseJoinExpiry("2026-12-31T18:00:00Z")?.toISOString(), "2026-12-31T18:00:00.000Z");
  assert.equal(parseJoinExpiry("2026-12-31T18:00:00-05:00")?.toISOString(), "2026-12-31T23:00:00.000Z");
});

test("what names no instant is refused", () => {
  for (const text of ["", "   ", "tomorrow", "2026-13-01", "2026-02-30", "2026-02-29"]) {
    assert.equal(parseJoinExpiry(text), null, text);
  }
  assert.ok(parseJoinExpiry("2028-02-29"), "a leap day is a date");
});
