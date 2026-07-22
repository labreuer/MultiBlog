"use client";

import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";
export type SortColumn<K extends string> = { key: K; dir: SortDirection };

// Click a column to sort by it (toggling asc/desc on repeat clicks of the
// same lone column); ctrl-click to add it as a secondary/tertiary/... sort
// key instead of replacing the current one. Exported (not just used
// internally by the hook below) so a caller whose sort state lives
// somewhere other than local useState — e.g. CommentsTable's URL-driven
// sort — can reuse the exact same toggle semantics instead of forking them.
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

export function useSortableRows<T, K extends string>(
  rows: T[],
  compareByKey: (key: K, a: T, b: T, dir: SortDirection) => number,
) {
  const [sortColumns, setSortColumns] = useState<SortColumn<K>[]>([]);

  function handleSort(key: K, addToSort: boolean) {
    setSortColumns((prev) => nextSortColumns(prev, key, addToSort));
  }

  // Null when `key` isn't part of the current sort; otherwise its direction
  // and 1-based priority among the active sort columns, for the caller to
  // render as an indicator (e.g. an arrow + superscript number).
  function sortState(key: K): { dir: SortDirection; priority: number } | null {
    const idx = sortColumns.findIndex((c) => c.key === key);
    if (idx === -1) return null;
    return { dir: sortColumns[idx].dir, priority: idx + 1 };
  }

  const sortedRows = useMemo(() => {
    if (sortColumns.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { key, dir } of sortColumns) {
        const cmp = compareByKey(key, a, b, dir);
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }, [rows, sortColumns, compareByKey]);

  return { sortedRows, handleSort, sortState };
}
