"use client";

import { useCallback, useMemo, useState } from "react";

// Row selection for bulk actions (PLAN.md §16g), generalized out of
// CommentsTable.
//
// Selection is scoped to the current page's rows: the header checkbox means
// "this page", and there is deliberately no "select all N matching" yet — the
// shape that should take is a filter-scoped server action rather than an id
// list, so a thousand-element array never crosses the wire (§16g, §16l).
//
// The selected set is *not* cleared on navigation. Selecting rows, paging
// away and paging back keeps them, which is the useful behaviour; what the
// header checkbox reflects is only ever the visible page.
export function useRowSelection<T extends { id: string }>(displayRows: T[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const allVisibleSelected = displayRows.length > 0 && displayRows.every((r) => selectedIds.has(r.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const row of displayRows) next.delete(row.id);
        return next;
      }
      return new Set([...prev, ...displayRows.map((r) => r.id)]);
    });
  }, [allVisibleSelected, displayRows]);

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectedRows = useMemo(
    () => displayRows.filter((r) => selectedIds.has(r.id)),
    [displayRows, selectedIds],
  );

  return {
    selectedIds,
    selectedRows,
    selectedCount: selectedIds.size,
    allVisibleSelected,
    toggleSelectAll,
    toggleRow,
    clearSelection,
  };
}
