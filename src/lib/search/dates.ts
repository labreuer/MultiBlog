// docs/FULLTEXT.md §6, "Dates" — a day in the viewer's time zone, as the
// range of UTC instants it covers.
//
// Pure and browser-safe, with no date library: `Intl` already knows every
// zone's offsets, and asking it what the wall clock reads at a given instant
// is enough to find where a zone's midnight falls. The server's own zone is
// never consulted, for the reason `LocalTime` exists: it isn't the reader's.

import type { DayRange } from "./params";

/** `{ gte, lt }` over UTC instants: what Prisma takes for a DateTime range. */
export type InstantRange = { gte?: Date; lt?: Date };

/** What the wall clock in `timeZone` reads at `instant`, as if that reading were UTC. */
function wallClockAsUtc(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/** The zone's offset from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  // Whole seconds only: formatToParts has no milliseconds, so the instant is
  // truncated to match before the subtraction.
  return wallClockAsUtc(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant `day` (`YYYY-MM-DD`) begins in `timeZone`.
 *
 * Midnight as UTC, shifted back by the offset in force there, and then by the
 * offset in force at *that* guess, because the first can land across a
 * daylight-saving change from the true answer. Of the two, the earlier one
 * whose wall clock already reads `day` wins. That is the second pass
 * everywhere except where a change skips midnight itself (Chile's spring
 * change, for one): there no instant reads 00:00, the second pass lands an
 * hour into the day before, and the day begins at the first instant that
 * exists — 01:00, which the first guess is.
 */
export function startOfDay(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const midnightAsUtc = Date.UTC(y, m - 1, d);
  const first = midnightAsUtc - offsetAt(midnightAsUtc, timeZone);
  const second = midnightAsUtc - offsetAt(first, timeZone);
  const onTheDay = [second, first].filter((instant) => wallClockAsUtc(instant, timeZone) >= midnightAsUtc);
  return new Date(onTheDay.length > 0 ? Math.min(...onTheDay) : second);
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * An inclusive range of days as the instants it covers: from the first day's
 * midnight up to, and not including, the midnight after the last. Null when
 * neither end is set, so the caller adds no clause at all.
 */
export function dayRangeToInstants(range: DayRange, timeZone: string): InstantRange | null {
  if (range.from === null && range.to === null) return null;
  const instants: InstantRange = {};
  if (range.from !== null) instants.gte = startOfDay(range.from, timeZone);
  if (range.to !== null) instants.lt = startOfDay(nextDay(range.to), timeZone);
  return instants;
}

/** Whether `instant` falls inside `range` — the JS twin of the Prisma clause, for the two kinds filtered after loading (§6). */
export function isWithin(instant: Date, range: InstantRange | null): boolean {
  if (range === null) return true;
  if (range.gte && instant < range.gte) return false;
  if (range.lt && instant >= range.lt) return false;
  return true;
}
