// "3 days ago" / "yesterday" / "just now" for a timestamp, relative to `now`.
// Pure and browser-safe.
//
// Only for values that arrived by a client-side fetch — the link picker's
// rows — where the text is never part of the SSR HTML and so can't trip the
// hydration mismatch src/components/LocalTime.tsx exists to avoid. Anything
// rendered on the server wants LocalTime instead.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];

export function relativeTime(iso: string, now: number): string {
  const delta = new Date(iso).getTime() - now;
  if (Number.isNaN(delta)) return "";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return formatter.format(Math.round(delta / ms), unit);
  }
  return "just now";
}
