import { SAFE_COLOR } from "./safe-css";
import { NEUTRAL_THREAD_COLOR } from "./author-colors";

// PLAN.md §14e's three-level cascade: link override, then group override,
// then the link's author's own color. Pure and client-safe (no prisma
// import) — used by SideBySideView (both the first paint and every
// recompute after a group's override_color is edited) as the one place
// this rule lives, rather than risking a second copy drifting.
export function cascadeDocLinkColor(
  linkOverrideColor: string | null,
  groupOverrideColor: string | null,
  authorColor: string,
): string {
  const color = linkOverrideColor ?? groupOverrideColor ?? authorColor;
  return SAFE_COLOR.test(color) ? color : NEUTRAL_THREAD_COLOR;
}
