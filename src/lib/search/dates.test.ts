import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRangeToInstants, isWithin, startOfDay } from "./dates";

// docs/FULLTEXT.md §6 — a date filter is a day in the reader's zone. The
// fixed cases pin known offsets; the sweep checks the defining property
// across a whole year in zones whose rules are awkward, which is where a
// hand-rolled conversion goes wrong.

test("midnight in fixed and familiar zones", () => {
  assert.equal(startOfDay("2026-10-04", "UTC").toISOString(), "2026-10-04T00:00:00.000Z");
  assert.equal(startOfDay("2026-07-01", "America/New_York").toISOString(), "2026-07-01T04:00:00.000Z");
  assert.equal(startOfDay("2026-01-15", "America/New_York").toISOString(), "2026-01-15T05:00:00.000Z");
  assert.equal(startOfDay("2026-10-04", "Asia/Kolkata").toISOString(), "2026-10-03T18:30:00.000Z");
  // UTC+13:45 in the southern summer: the day begins the previous morning in UTC.
  assert.equal(startOfDay("2026-01-10", "Pacific/Chatham").toISOString(), "2026-01-09T10:15:00.000Z");
});

test("a daylight-saving day is 23 or 25 hours long", () => {
  const hours = (day: string, next: string, zone: string) =>
    (startOfDay(next, zone).getTime() - startOfDay(day, zone).getTime()) / 3_600_000;
  assert.equal(hours("2026-03-08", "2026-03-09", "America/New_York"), 23);
  assert.equal(hours("2026-11-01", "2026-11-02", "America/New_York"), 25);
  // Lord Howe moves by half an hour.
  assert.equal(hours("2026-10-04", "2026-10-05", "Australia/Lord_Howe"), 23.5);
});

// The defining property: the instant reads as `day` in the zone, and one
// second earlier does not. That holds for every day, including the ones where
// a change skips midnight altogether (Chile, Cuba) and 00:00 never exists.
const localDay = (instant: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);

test("every day of 2026 begins on that day, and not a second sooner", () => {
  const zones = ["America/Santiago", "America/Havana", "Asia/Beirut", "Australia/Lord_Howe", "Europe/London", "Pacific/Apia"];
  for (const zone of zones) {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const start = startOfDay(day, zone);
      assert.equal(localDay(start, zone), day, `${zone} ${day} begins on the day`);
      assert.notEqual(localDay(new Date(start.getTime() - 1000), zone), day, `${zone} ${day} begins no later`);
    }
  }
});

test("a range covers its first day to the midnight after its last", () => {
  assert.equal(dayRangeToInstants({ from: null, to: null }, "UTC"), null);
  const range = dayRangeToInstants({ from: "2026-10-01", to: "2026-10-04" }, "America/New_York")!;
  assert.equal(range.gte!.toISOString(), "2026-10-01T04:00:00.000Z");
  assert.equal(range.lt!.toISOString(), "2026-10-05T04:00:00.000Z");
  const open = dayRangeToInstants({ from: null, to: "2026-12-31" }, "UTC")!;
  assert.equal(open.gte, undefined);
  assert.equal(open.lt!.toISOString(), "2027-01-01T00:00:00.000Z");

  assert.equal(isWithin(new Date("2026-10-04T23:59:59Z"), range), true);
  assert.equal(isWithin(new Date("2026-10-05T04:00:00Z"), range), false);
  assert.equal(isWithin(new Date("2026-10-01T03:59:59Z"), range), false);
  assert.equal(isWithin(new Date("1999-01-01T00:00:00Z"), null), true);
});
