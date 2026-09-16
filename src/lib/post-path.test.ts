import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePostDatePrefix,
  parsePostDateSegments,
  postDateArchivePaths,
  postDateLabel,
  postDateParts,
  postDateTimeLabel,
  postPath,
} from "./post-path";

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

test("postDateTimeLabel is the full UTC timestamp, to the second", () => {
  assert.equal(postDateTimeLabel(LATE_EVENING_EDT), "2026-08-05 03:30:00 UTC");
  assert.equal(postDateTimeLabel(new Date("2026-01-01T00:00:00.999Z")), "2026-01-01 00:00:00 UTC");
});

test("postDateArchivePaths are the three prefixes of postPath", () => {
  assert.deepEqual(postDateArchivePaths(LATE_EVENING_EDT), ["/2026", "/2026/08", "/2026/08/05"]);
});

// §21h — the archive routes' gate. Same rejection surface as the full date,
// plus the prefix shapes: a year alone, a year and month, all three.
test("parsePostDatePrefix returns a half-open UTC range per prefix length", () => {
  assert.deepEqual(parsePostDatePrefix("2026"), {
    start: new Date("2026-01-01T00:00:00Z"),
    end: new Date("2027-01-01T00:00:00Z"),
    label: "2026",
    path: "/2026",
  });
  assert.deepEqual(parsePostDatePrefix("2026", "02"), {
    start: new Date("2026-02-01T00:00:00Z"),
    end: new Date("2026-03-01T00:00:00Z"),
    label: "2026-02",
    path: "/2026/02",
  });
  assert.deepEqual(parsePostDatePrefix("2024", "12"), {
    start: new Date("2024-12-01T00:00:00Z"),
    end: new Date("2025-01-01T00:00:00Z"),
    label: "2024-12",
    path: "/2024/12",
  });
  assert.deepEqual(parsePostDatePrefix("2024", "02", "29"), {
    start: new Date("2024-02-29T00:00:00Z"),
    end: new Date("2024-03-01T00:00:00Z"),
    label: "2024-02-29",
    path: "/2024/02/29",
  });
});

test("parsePostDatePrefix rejects the wrong shape", () => {
  assert.equal(parsePostDatePrefix("tag"), null);
  assert.equal(parsePostDatePrefix("26"), null);
  assert.equal(parsePostDatePrefix("20260"), null);
  assert.equal(parsePostDatePrefix("0050"), null);
  assert.equal(parsePostDatePrefix("2026", "9"), null);
  assert.equal(parsePostDatePrefix("2026", "sep"), null);
  assert.equal(parsePostDatePrefix("2026", "09", "5"), null);
  assert.equal(parsePostDatePrefix("2026", "09", "15 "), null);
  assert.equal(parsePostDatePrefix("2026", undefined, "15"), null);
});

test("parsePostDatePrefix rejects a month or day that does not exist", () => {
  assert.equal(parsePostDatePrefix("2026", "00"), null);
  assert.equal(parsePostDatePrefix("2026", "13"), null);
  assert.equal(parsePostDatePrefix("2026", "02", "30"), null);
  assert.equal(parsePostDatePrefix("2023", "02", "29"), null);
  assert.equal(parsePostDatePrefix("2026", "04", "31"), null);
  assert.equal(parsePostDatePrefix("2026", "04", "00"), null);
});
