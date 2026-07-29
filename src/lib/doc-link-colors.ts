import { SAFE_COLOR } from "./safe-css";

// PLAN.md §14e's three-level cascade: link override, then group override,
// then the link's author's own color. Pure and client-safe (no prisma
// import) so both the server (doc-links-query.ts's buildDocLinkInputs, the
// first paint) and the client (SideBySideView, recomputing after a group's
// override_color is edited) share the exact same rule instead of risking
// two copies drifting.
export function cascadeDocLinkColor(
  linkOverrideColor: string | null,
  groupOverrideColor: string | null,
  authorColor: string,
): string {
  const color = linkOverrideColor ?? groupOverrideColor ?? authorColor;
  return SAFE_COLOR.test(color) ? color : "#999";
}
