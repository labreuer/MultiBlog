import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePostDateSegments, postDateLabel, postDateParts, postPath } from "./post-path";

// PLAN.md §21b — the URL is derived in UTC, whatever the box's timezone.
// 2026-08-04T23:30 in New York (EDT, UTC-4) is already the 5th in UTC.
const LATE_EVENING_EDT = new Date("2026-08-04T23:30:00-04:00");

test("postDateParts reads UTC, not local time", () => {
  assert.deepEqual(postDateParts(LATE_EVENING_EDT), { year: "2026", month: "08", day: "05" });
  assert.deepEqual(postDateParts(new Date("2026-01-01T00:00:00Z")), { year: "2026", month: "01", day: "01" });
});

test("postPath and postDateLabel come from the same parts", () => {
  assert.equal(postPath({ slug: "late-night", publishedAt: LATE_EVENING_EDT }), "/2026/08/05/late-night");
  assert.equal(postDateLabel(LATE_EVENING_EDT), "2026-08-05");
});

test("postPath refuses a draft", () => {
  assert.throws(() => postPath({ slug: "draft", publishedAt: null }), /no publishedAt/);
});

// The rejection surface is the point: the route matches every four-segment
// path nothing static claims, and each case below is something a URL can
// carry that must 404 without a query (§21a).
test("parsePostDateSegments accepts a real, zero-padded date", () => {
  assert.deepEqual(parsePostDateSegments("2026", "08", "05"), { year: "2026", month: "08", day: "05" });
  assert.deepEqual(parsePostDateSegments("2024", "02", "29"), { year: "2024", month: "02", day: "29" });
});

test("parsePostDateSegments rejects the wrong shape", () => {
  assert.equal(parsePostDateSegments("a", "b", "c"), null);
  assert.equal(parsePostDateSegments("26", "08", "05"), null);
  assert.equal(parsePostDateSegments("2026", "8", "5"), null);
  assert.equal(parsePostDateSegments("2026", "08", "5"), null);
  assert.equal(parsePostDateSegments("20260", "08", "05"), null);
  assert.equal(parsePostDateSegments("2026", "08", "05 "), null);
  assert.equal(parsePostDateSegments("-026", "08", "05"), null);
});

test("parsePostDateSegments rejects a date that does not exist", () => {
  assert.equal(parsePostDateSegments("2026", "02", "30"), null);
  assert.equal(parsePostDateSegments("2026", "13", "01"), null);
  assert.equal(parsePostDateSegments("2026", "00", "10"), null);
  assert.equal(parsePostDateSegments("2026", "04", "31"), null);
  assert.equal(parsePostDateSegments("2023", "02", "29"), null);
  assert.equal(parsePostDateSegments("0050", "01", "01"), null);
});
