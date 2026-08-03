"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReadonlyURLSearchParams } from "next/navigation";

// Keeps a row this tab just deleted visible until fresh server data either
// confirms or supersedes it (PLAN.md §16d) — deleting one row shouldn't yank
// it out of view before the admin can see what happened, or undo it.
//
// A Map of whole rows, not the pre-pagination tables' Set of ids: once a page
// is a real `take`/`skip` query, the refetch that follows a delete doesn't
// return the row at all when `deleted` is off, so there is nothing left for a
// flag to point at. The overlay has to carry the row itself.
//
// Cleared whenever the querystring actually changes (a real filter/sort/page
// navigation), but not by the same-URL refresh a delete/restore/moderate
// triggers — that refresh is what confirms the overlay, not what invalidates
// it.
export function useRevealedRows<T extends { id: string; deleted: boolean }>(
  rows: T[],
  searchParams: ReadonlyURLSearchParams,
) {
  const [revealedRows, setRevealedRows] = useState<Map<string, T>>(new Map());
  const prevSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    const current = searchParams.toString();
    if (prevSearchParamsRef.current !== current) {
      prevSearchParamsRef.current = current;
      setRevealedRows(new Map());
    }
  }, [searchParams]);

  function revealRow(row: T) {
    setRevealedRows((prev) => new Map(prev).set(row.id, { ...row, deleted: true }));
  }

  function revealRows(rowsToReveal: T[]) {
    setRevealedRows((prev) => {
      const next = new Map(prev);
      for (const row of rowsToReveal) next.set(row.id, { ...row, deleted: true });
      return next;
    });
  }

  // An overlay entry drops out the instant `rows` contains that id again —
  // which is also what makes restore need no cleanup of its own: once the
  // refreshed row says deleted:false, this rule has already discarded the
  // overlay copy that said otherwise.
  const displayRows = useMemo(() => {
    const overlayOnly = [...revealedRows.values()].filter((r) => !rows.some((row) => row.id === r.id));
    return [...rows, ...overlayOnly];
  }, [rows, revealedRows]);

  return { displayRows, revealRow, revealRows };
}
