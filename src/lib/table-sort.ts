export type SortDirection = "asc" | "desc";
export type SortColumn<K extends string> = { key: K; dir: SortDirection };

// Click a column to sort by it (toggling asc/desc on repeat clicks of the
// same lone column); ctrl-click to add it as a secondary/tertiary/... sort
// key instead of replacing the current one.
//
// This file was use-sortable-rows.ts, and held a useSortableRows hook that
// also *did* the sorting, client-side, over an array of every row. Once every
// admin table paginated (PLAN.md §16e) that hook had no callers: sorting is
// an ORDER BY now, and the sort state lives in the querystring. What survives
// is the toggle semantics — the one part that was always about what a click
// means rather than where the rows come from. No "use client" any more
// either: the server pages import SortColumn to build their orderBy.
export function nextSortColumns<K extends string>(
  prev: SortColumn<K>[],
  key: K,
  addToSort: boolean,
): SortColumn<K>[] {
  const idx = prev.findIndex((c) => c.key === key);
  if (addToSort) {
    if (idx === -1) {
      return [...prev, { key, dir: "asc" }];
    }
    const next = [...prev];
    next[idx] = { key, dir: next[idx].dir === "asc" ? "desc" : "asc" };
    return next;
  }
  if (prev.length === 1 && idx === 0) {
    return [{ key, dir: prev[0].dir === "asc" ? "desc" : "asc" }];
  }
  return [{ key, dir: "asc" }];
}
