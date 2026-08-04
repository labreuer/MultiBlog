"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSiteDefaultColumnOrder } from "@/app/actions/site-settings";
import type { AdminTableName } from "@/lib/column-order";
import type { ColumnMeta } from "@/lib/admin-table-columns";
import { CellError } from "@/components/table/TableControls";
import styles from "@/components/table/AdminTable.module.css";

// Site-wide default column visibility *and order* per table (PLAN.md §16i/
// §16m) — the layer between a column's own code-level `defaultHidden` and a
// user's own saved `column_order` (which still wins: "users having an
// override" is that existing per-user preference, not a new mechanism).
//
// Visibility and order are one control here for the same reason they are one
// control in `ColumnPicker` (§16i): `SiteSettings.defaultColumnOrder` is a
// single ordered list where membership is visibility and position is order,
// so there is nothing for a second control to own. The drag handling reuses
// `ColumnPicker`'s own mechanics and CSS classes rather than a second
// implementation of the same gesture — only checked rows are draggable there
// too, for the same reason: there is no meaningful position for a column
// that isn't shown.
export function DefaultColumnsEditor({
  table,
  columns,
  initialChecked,
}: {
  table: AdminTableName;
  columns: ColumnMeta[];
  /** The keys currently in the effective default (site override, or the code default if none), in order. */
  initialChecked: string[];
}) {
  const router = useRouter();
  const [order, setOrder] = useState(initialChecked);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dragKeyRef = useRef<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const isVisible = (key: string) => order.includes(key);
  // Visible ones first in their current order, then the hidden ones in
  // declaration order — same rule `ColumnPicker`'s `pickerColumns` uses, so
  // dragging reorders what's checked and the rest wait below to be turned on.
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const listed = [
    ...order.map((key) => byKey.get(key)).filter((column): column is ColumnMeta => !!column),
    ...columns.filter((column) => !order.includes(column.key)),
  ];

  function save(next: string[]) {
    const prev = order;
    setOrder(next);
    setError(null);
    startTransition(async () => {
      try {
        await updateSiteDefaultColumnOrder(table, next);
        router.refresh();
      } catch (err) {
        // Revert rather than leaving a checkbox/position showing a state that
        // didn't actually save.
        setOrder(prev);
        setError(err instanceof Error ? err.message : "Failed to update default columns.");
      }
    });
  }

  function toggle(key: string, checked: boolean) {
    // Appended rather than restored to its declared slot — same as
    // ColumnPicker: the list the admin is looking at is the order.
    save(checked ? [...order, key] : order.filter((k) => k !== key));
  }

  function handleDrop(targetKey: string) {
    const dragKey = dragKeyRef.current;
    dragKeyRef.current = null;
    setDragOverKey(null);
    if (!dragKey || dragKey === targetKey || !isVisible(dragKey) || !isVisible(targetKey)) return;

    const next = [...order];
    next.splice(next.indexOf(dragKey), 1);
    next.splice(next.indexOf(targetKey), 0, dragKey);
    save(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* `columnPickerList`'s max-height/overflow-y exist for ColumnPicker's
          dropdown, which has to fit under a `<summary>` toggle without
          pushing the page around. This editor is a plain table cell with no
          such constraint, so it opts back out — the section should be as
          tall as its content needs. */}
      <div className={styles.columnPickerList} style={{ maxHeight: "none", overflowY: "visible" }}>
        {listed.map((column) => {
          const checked = isVisible(column.key);
          return (
            <label
              key={column.key}
              className={[
                styles.columnRow,
                checked ? styles.columnRowDraggable : "",
                dragOverKey === column.key ? styles.columnDragOver : "",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable={checked && !pending}
              onDragStart={() => {
                dragKeyRef.current = column.key;
              }}
              onDragOver={(e) => {
                if (!checked || !dragKeyRef.current) return;
                e.preventDefault();
                setDragOverKey(column.key);
              }}
              onDragLeave={() => setDragOverKey((key) => (key === column.key ? null : key))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(column.key);
              }}
              onDragEnd={() => {
                dragKeyRef.current = null;
                setDragOverKey(null);
              }}
            >
              <span className={styles.columnDragHandle}>{checked ? "⠿" : "  "}</span>
              <input
                type="checkbox"
                checked={checked}
                disabled={pending}
                onChange={(e) => toggle(column.key, e.target.checked)}
              />
              {column.label}
            </label>
          );
        })}
      </div>
      <CellError message={error} />
    </div>
  );
}
