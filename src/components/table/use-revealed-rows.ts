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
// It carries the row's **index** too, and puts it back there rather than
// appending. Appending was the obvious thing and read as a bug: deleting the
// second of four rows sent it to the bottom of the table, which looks like the
// list re-sorting itself for no reason. The index is captured at reveal time,
// while `rows` still contains the row, so it costs the caller nothing.
//
// The alternative was to stop dropping these rows in SQL — pass the just-
// deleted ids back to the server and widen the WHERE, so Postgres returns them
// in their sorted place. That is more truthful (the row would be counted and
// paginated like any other) but it turns the ids into a sixth shared
// querystring param, and with it: bookmarkable URLs that resurrect rows for
// whoever opens them, a FilterHelp entry for something nobody types, a
// changing total, and a revealed row displacing a live one onto the next page.
// Splicing keeps all of that out for the case that actually matters — a row
// *this admin just deleted*, where nothing else on the page has moved.
//
// Cleared whenever the querystring actually changes (a real filter/sort/page
// navigation), but not by the same-URL refresh a delete/restore/moderate
// triggers — that refresh is what confirms the overlay, not what invalidates
// it.
type RevealedRow<T> = { row: T; index: number };

export function useRevealedRows<T extends { id: string; deleted: boolean }>(
  rows: T[],
  searchParams: ReadonlyURLSearchParams,
) {
  const [revealedRows, setRevealedRows] = useState<Map<string, RevealedRow<T>>>(new Map());
  const prevSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    const current = searchParams.toString();
    if (prevSearchParamsRef.current !== current) {
      prevSearchParamsRef.current = current;
      setRevealedRows(new Map());
    }
  }, [searchParams]);

  // Both of these are called while `rows` still holds the row — the callers
  // reveal *after* awaiting the delete but before the refresh lands — so the
  // index is simply where it currently sits. A row that somehow isn't there
  // falls back to the end, which is the old behaviour.
  function indexOf(rowId: string) {
    const at = rows.findIndex((row) => row.id === rowId);
    return at === -1 ? rows.length : at;
  }

  function revealRow(row: T) {
    setRevealedRows((prev) =>
      new Map(prev).set(row.id, { row: { ...row, deleted: true }, index: indexOf(row.id) }),
    );
  }

  function revealRows(rowsToReveal: T[]) {
    setRevealedRows((prev) => {
      const next = new Map(prev);
      for (const row of rowsToReveal) {
        next.set(row.id, { row: { ...row, deleted: true }, index: indexOf(row.id) });
      }
      return next;
    });
  }

  // An overlay entry drops out the instant `rows` contains that id again —
  // which is also what makes restore need no cleanup of its own: once the
  // refreshed row says deleted:false, this rule has already discarded the
  // overlay copy that said otherwise.
  const displayRows = useMemo(() => {
    const overlayOnly = [...revealedRows.values()].filter((r) => !rows.some((row) => row.id === r.row.id));
    if (overlayOnly.length === 0) return rows;

    // Ascending, so each row lands in the slot it originally held: everything
    // before it has already been put back by the time it is inserted. Clamped
    // because the indices describe the page as it was, and a concurrent change
    // elsewhere could leave `rows` shorter than one of them.
    const restored = [...rows];
    for (const { row, index } of [...overlayOnly].sort((a, b) => a.index - b.index)) {
      restored.splice(Math.min(index, restored.length), 0, row);
    }
    return restored;
  }, [rows, revealedRows]);

  return { displayRows, revealRow, revealRows };
}
