"use client";

import { useState } from "react";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
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
        run: (ids: string[]) => Promise<void>;
      }
    | {
        // For "set every selected row's role/visibility to X" — a value the
        // admin picks, rather than a fixed verb. Resets to its placeholder
        // after running, so the toolbar never implies the selection currently
        // *has* that value.
        kind: "select";
        options: readonly string[];
        run: (ids: string[], value: string) => Promise<void>;
      }
  );

export function BulkToolbar<T extends { id: string }>({
  selectedRows,
  actions,
  onDone,
  onDeleted,
}: {
  selectedRows: T[];
  actions: BulkAction<T>[];
  onDone: () => void;
  // Lets a table keep just-deleted rows visible (useRevealedRows) when the
  // action that ran was a deletion; it gets the rows the action actually
  // applied to, not the whole selection.
  onDeleted?: (rows: T[]) => void;
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
    try {
      if (action.kind === "select") {
        await action.run(ids, value!);
      } else {
        await action.run(ids);
        if (action.icon === "delete") onDeleted?.(targetRows);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk action failed.");
    } finally {
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
      {error && <span style={{ color: "crimson" }}>{error}</span>}
    </div>
  );
}

// The delete/restore pair every table's toolbar ends with, since all five
// share soft-deletion. `noun` only shapes the accessible label.
export function softDeleteBulkActions<T extends { deleted: boolean }>(
  noun: string,
  bulkDelete: (ids: string[]) => Promise<void>,
  bulkRestore: (ids: string[]) => Promise<void>,
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
