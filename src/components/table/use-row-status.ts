"use client";

import { useCallback, useMemo, useState } from "react";
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

  const setStatus = useCallback((rowId: string, status: RowStatus) => {
    setStatuses((prev) => {
      const next = new Map(prev);
      if (status === "idle") next.delete(rowId);
      else next.set(rowId, status);
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

  return useMemo(
    () => ({ rowStatusClass, setStatus, runWithStatus }),
    [rowStatusClass, setStatus, runWithStatus],
  );
}
