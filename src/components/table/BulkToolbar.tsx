"use client";

import { useState } from "react";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import type { BulkFailure, BulkResult } from "@/lib/bulk-result";
import styles from "./AdminTable.module.css";

// The toolbar that appears once anything is selected (PLAN.md §16g). A table
// declares its bulk actions as data and this renders them, so "what can be
// done in bulk here" is a list in the table rather than a block of JSX
// repeated per surface.
//
// `run` takes server actions, never a table name: each table's batched
// actions enforce their own authorization, and routing them through a shared
// dispatcher would put that decision somewhere it doesn't belong.
//
// Rows an action doesn't apply to are dropped silently rather than erroring on
// a mixed selection — the rule bulkModerateComments established, now the
// convention every bulk action follows. An action whose applicable set is
// empty is a no-op.
type BulkActionBase<T> = {
  key: string;
  label: string;
  applicableTo: (row: T) => boolean;
};

export type BulkAction<T> = BulkActionBase<T> &
  (
    | {
        kind: "button";
        /** Rendered instead of the label when set — for the delete/restore pair. */
        icon?: "delete" | "restore";
        /** Extra classes for the button (a table's own action colors). */
        className?: string;
        /** Sets destructive actions apart from the rest of the toolbar. */
        separated?: boolean;
        run: (ids: string[]) => Promise<BulkResult>;
      }
    | {
        // For "set every selected row's role/visibility to X" — a value the
        // admin picks, rather than a fixed verb. Resets to its placeholder
        // after running, so the toolbar never implies the selection currently
        // *has* that value.
        kind: "select";
        options: readonly string[];
        run: (ids: string[], value: string) => Promise<BulkResult>;
      }
  );

export function BulkToolbar<T extends { id: string }>({
  selectedRows,
  actions,
  onDone,
  onDeleted,
  runWithStatus,
}: {
  selectedRows: T[];
  actions: BulkAction<T>[];
  // Called once the action settles, either way. `ok` is false when it threw,
  // and the split every table makes with it is: refresh regardless, clear the
  // selection only on success.
  //
  // Refreshing regardless is not cosmetic. These actions are not transactional
  // (PLAN.md §16k) and run per id under Promise.all, so a rejection still
  // leaves the ids that succeeded committed. Skipping the refresh left those
  // rows showing their old values beside a red border until someone reloaded —
  // i.e. §16k's claim that "a partial application is visible" was not true.
  // Keeping the selection armed on failure is the other half: the action is
  // re-runnable without re-picking the rows.
  onDone: (ok: boolean) => void;
  // Lets a table keep just-deleted rows visible (useRevealedRows) when the
  // action that ran was a deletion; it gets the rows the action actually
  // applied to, not the whole selection.
  onDeleted?: (rows: T[]) => void;
  // `runWithStatusMany` from the table's own useRowStatus (§16f), so a bulk
  // change paints the same amber → green/red border on each affected row that
  // a single-cell edit does. Required rather than optional: every table on the
  // kit already paints the border, and an optional prop is one a new table can
  // quietly omit, leaving its bulk actions the only mutations on the surface
  // that give no per-row feedback.
  runWithStatus: (rowIds: string[], action: () => Promise<BulkFailure[]>) => Promise<BulkFailure[]>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (selectedRows.length === 0) return null;

  async function handle(action: BulkAction<T>, value?: string) {
    setError(null);
    const targetRows = selectedRows.filter(action.applicableTo);
    if (targetRows.length === 0) return;
    const ids = targetRows.map((r) => r.id);

    setPending(true);
    let ok = false;
    try {
      // Wraps only the server call, so the borders settle on saved/error
      // before onDone clears the selection and refreshes — the rows the
      // action touched stay marked once they are no longer selected, which is
      // what makes the border readable as "these are the ones that changed".
      const failed = await runWithStatus(ids, async () => {
        const result = action.kind === "select" ? await action.run(ids, value!) : await action.run(ids);
        return result.failed;
      });

      // A partial failure resolves rather than throws, so `ok` is about the
      // batch as a whole: it decides whether the selection is cleared, and any
      // failure at all means keep it armed for a re-run. The rows have already
      // been painted individually by then.
      ok = failed.length === 0;
      if (!ok) {
        setError(
          failed.length === 1
            ? failed[0].message
            : `${failed.length} of ${ids.length} failed — hover a red row for its reason.`,
        );
      }
    } catch (e) {
      // A throw is the whole batch failing at once (unauthenticated, offline,
      // a bug) rather than some ids being refused; runWithStatus has already
      // reddened every row. This is the toolbar's own message, which says
      // *what* failed where the border only says *that* something did.
      setError(e instanceof Error ? e.message : "Bulk action failed.");
    } finally {
      // Both of these run on the failure path too, and a partly-succeeded
      // delete is exactly why. The batched actions are Promise.all over
      // per-id calls, so a rejection does not stop the others — the ids that
      // succeeded are already committed by the time the error arrives.
      //
      // Revealing on failure: the rows that did delete are gone from a
      // ?deleted=0 refetch, so without the overlay they would vanish mid-
      // action, taking their border with them. A row that *didn't* delete
      // costs nothing here — useRevealedRows drops an overlay entry the moment
      // `rows` contains that id again, which it still does for a live row.
      if (action.kind === "button" && action.icon === "delete") onDeleted?.(targetRows);
      onDone(ok);
      setPending(false);
    }
  }

  return (
    <div className={styles.bulkToolbar}>
      <span>{selectedRows.length} selected</span>
      {actions.map((action) => {
        if (action.kind === "select") {
          return (
            <label key={action.key}>
              {action.label}:{" "}
              <select
                value=""
                disabled={pending}
                aria-label={action.label}
                onChange={(e) => {
                  const value = e.target.value;
                  e.target.value = "";
                  if (value) void handle(action, value);
                }}
              >
                <option value="">—</option>
                {action.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        const iconOnly = action.icon !== undefined;
        const className = [
          iconOnly ? styles.iconButton : styles.actionButton,
          action.icon === "delete" ? styles.iconButtonDanger : "",
          action.icon === "restore" ? styles.iconButtonMuted : "",
          action.separated ? styles.bulkDangerSpacing : "",
          action.className ?? "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <button
            key={action.key}
            type="button"
            disabled={pending}
            onClick={() => handle(action)}
            aria-label={iconOnly ? action.label : undefined}
            title={iconOnly ? action.label : undefined}
            className={className}
          >
            {action.icon === "delete" ? (
              <IconTrash size={16} />
            ) : action.icon === "restore" ? (
              <IconTrashOff size={16} />
            ) : (
              action.label
            )}
          </button>
        );
      })}
      {error && <span style={{ color: "var(--error)" }}>{error}</span>}
    </div>
  );
}

// The delete/restore pair every table's toolbar ends with, since all five
// share soft-deletion. `noun` only shapes the accessible label.
export function softDeleteBulkActions<T extends { deleted: boolean }>(
  noun: string,
  bulkDelete: (ids: string[]) => Promise<BulkResult>,
  bulkRestore: (ids: string[]) => Promise<BulkResult>,
): BulkAction<T & { id: string }>[] {
  return [
    {
      kind: "button",
      key: "delete",
      label: `Delete selected ${noun}`,
      icon: "delete",
      separated: true,
      applicableTo: (row) => !row.deleted,
      run: bulkDelete,
    },
    {
      kind: "button",
      key: "restore",
      label: `Restore selected ${noun}`,
      icon: "restore",
      applicableTo: (row) => row.deleted,
      run: bulkRestore,
    },
  ];
}

// The selection column's header checkbox and per-row checkbox, so a table
// doesn't restate the aria wiring five times.
export function SelectAllHeader({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <th className={styles.headerCell}>
      <input type="checkbox" checked={checked} onChange={onChange} aria-label="Select all rows" />
    </th>
  );
}

export function SelectRowCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return <input type="checkbox" checked={checked} onChange={onChange} aria-label={`Select ${label}`} />;
}
