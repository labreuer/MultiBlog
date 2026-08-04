"use client";

import { useCallback, useMemo, useState } from "react";
import type { BulkFailure } from "@/lib/bulk-result";
import styles from "./AdminTable.module.css";

// What this visit has done to a row (PLAN.md §16f), painted as a 3px left
// border on the row's first cell.
//
// Replaces the savedPulse animation UsersTable and SiteSettingsTable used. A
// pulse is a momentary acknowledgement, gone a second later; an admin editing
// several rows in a row wants a standing record of which ones they touched.
// So "saved" and "error" persist until that row is edited again or the page
// navigates — deliberately no timer.
export type RowStatus = "idle" | "edited" | "saving" | "error" | "saved";

const STATUS_CLASS: Record<RowStatus, string> = {
  idle: "",
  edited: styles.rowStatusEdited,
  saving: styles.rowStatusSaving,
  error: styles.rowStatusError,
  saved: styles.rowStatusSaved,
};

export function useRowStatus() {
  const [statuses, setStatuses] = useState<Map<string, RowStatus>>(new Map());
  // Why a row is red, for the rows that can say. Only bulk actions populate
  // this — a single-cell edit already has the table's own error text under the
  // control, which is more visible than a tooltip. A bulk action has one
  // toolbar and N rows, so the row is the only place a *per-row* reason can go.
  const [messages, setMessages] = useState<Map<string, string>>(new Map());

  const setStatus = useCallback((rowId: string, status: RowStatus) => {
    setStatuses((prev) => {
      const next = new Map(prev);
      if (status === "idle") next.delete(rowId);
      else next.set(rowId, status);
      return next;
    });
  }, []);

  // One Map update for the whole batch rather than N calls to setStatus: a
  // bulk action can cover a full page of rows, and every row's border has to
  // turn amber in the same paint or the toolbar looks like it is working
  // through them one at a time.
  const setStatusMany = useCallback((rowIds: string[], status: RowStatus) => {
    if (rowIds.length === 0) return;
    setStatuses((prev) => {
      const next = new Map(prev);
      for (const rowId of rowIds) {
        if (status === "idle") next.delete(rowId);
        else next.set(rowId, status);
      }
      return next;
    });
  }, []);

  // The class for a row's first <td>. Always includes .rowStatusCell, which
  // paints a transparent border — every row reserves the 3px whether or not
  // it has a status, so nothing shifts horizontally when one appears.
  const rowStatusClass = useCallback(
    (rowId: string) => {
      const status = statuses.get(rowId) ?? "idle";
      const modifier = STATUS_CLASS[status];
      return modifier ? `${styles.rowStatusCell} ${modifier}` : styles.rowStatusCell;
    },
    [statuses],
  );

  // Wraps a row mutation in the saving → saved/error transitions, so a cell
  // only has to say what it's doing, not narrate its own status. Rethrows
  // after marking, leaving the caller's own error text (which says *what*
  // failed — the border only says *that* something did) to its catch block.
  const runWithStatus = useCallback(
    async (rowId: string, action: () => Promise<void>) => {
      setStatus(rowId, "saving");
      try {
        await action();
        setStatus(rowId, "saved");
      } catch (e) {
        setStatus(rowId, "error");
        throw e;
      }
    },
    [setStatus],
  );

  // The bulk counterpart, for BulkToolbar. Same saving → saved/error shape, so
  // a bulk change reads on the row exactly like a single-cell edit does — which
  // is the point: an admin who just set eight users' roles at once wants the
  // same standing record of which rows they touched.
  //
  // Only the rows an action actually applied to are passed in, never the whole
  // selection. On a mixed selection (some rows already deleted, say) the ones
  // the action skipped stay idle, so the border also answers "which of my
  // selected rows did that actually do anything to?".
  //
  // `action` resolves with the *failures*, not with nothing: the batched server
  // actions return a BulkResult (src/lib/bulk-result.ts) rather than throwing
  // on the first bad id, so a half-successful batch can paint each row its own
  // colour. Green means that row saved, and means it — the reason these
  // actions stopped using `Promise.all`, which rejects on the first failure and
  // discards which ids the rest were.
  //
  // A throw still marks the whole batch red. That is the case where the client
  // genuinely does not know — an unauthenticated caller, a network failure, a
  // bug — and "check all of these" is the only honest reading of it.
  const runWithStatusMany = useCallback(
    async (rowIds: string[], action: () => Promise<BulkFailure[]>) => {
      setStatusMany(rowIds, "saving");
      setMessages((prev) => {
        if (rowIds.every((id) => !prev.has(id))) return prev;
        const next = new Map(prev);
        for (const id of rowIds) next.delete(id);
        return next;
      });
      try {
        const failures = await action();
        const failedIds = new Set(failures.map((f) => f.id));
        setStatusMany(
          rowIds.filter((id) => !failedIds.has(id)),
          "saved",
        );
        setStatusMany([...failedIds], "error");
        if (failures.length > 0) {
          setMessages((prev) => {
            const next = new Map(prev);
            for (const failure of failures) next.set(failure.id, failure.message);
            return next;
          });
        }
        return failures;
      } catch (e) {
        setStatusMany(rowIds, "error");
        throw e;
      }
    },
    [setStatusMany],
  );

  // The per-row reason, for a `title` on the same cell that paints the border.
  // Undefined for every state but a bulk error, so it never overrides a cell's
  // own tooltip with an empty string.
  const rowStatusTitle = useCallback((rowId: string) => messages.get(rowId), [messages]);

  return useMemo(
    () => ({ rowStatusClass, rowStatusTitle, setStatus, runWithStatus, runWithStatusMany }),
    [rowStatusClass, rowStatusTitle, setStatus, runWithStatus, runWithStatusMany],
  );
}
