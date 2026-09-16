// "in 2 days, 3 hours, 5 minutes" — the distance from now to a future
// instant, in the three units a schedule is thought about in. Zero units
// are dropped, so a post due in ninety minutes reads "in 1 hour, 30
// minutes". Anything under a minute, or already past, is "in under a
// minute": the caller only asks about a future date, since a scheduled post
// whose time has arrived is published rather than scheduled
// (derivePostStatus), so the past branch exists only to never print a
// negative.
export function formatTimeUntil(target: Date, now: Date = new Date()): string {
  const totalMinutes = Math.floor((target.getTime() - now.getTime()) / 60_000);
  if (totalMinutes < 1) return "in under a minute";
  const units: [number, string][] = [
    [Math.floor(totalMinutes / 1440), "day"],
    [Math.floor((totalMinutes % 1440) / 60), "hour"],
    [totalMinutes % 60, "minute"],
  ];
  const parts = units.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`);
  return `in ${parts.join(", ")}`;
}
