"use client";

import { useRef, useState, useTransition } from "react";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import type { ColumnSpec } from "./column-spec";
import { pickerColumns } from "./column-spec";
import styles from "./AdminTable.module.css";

// Which columns a table shows, and in what order (PLAN.md §16i).
//
// Visibility is a checkbox list and order is drag-to-reorder, in one control,
// because they are one piece of state: `?cols=` is a single ordered list where
// membership is visibility and position is order. Two separate controls would
// imply two params.
//
// The drag handling mirrors DocSettingsPanel's `.draggableRow`/`.dragOver`
// pattern rather than introducing a second gesture vocabulary for the same
// interaction — only checked rows are draggable there too, for the same reason:
// there is no meaningful position for a column that isn't shown.
export function ColumnPicker<Row>({
  columns,
  resolved,
  onChange,
  onSaveDefault,
  onReset,
  isDefault,
}: {
  /** Every column the table declares, in declaration order. */
  columns: ColumnSpec<Row>[];
  /** What is currently shown, in current order. */
  resolved: ColumnSpec<Row>[];
  onChange: (cols: string[]) => void;
  onSaveDefault: (cols: string[]) => Promise<void>;
  onReset: () => void;
  /** Whether the current view already matches this user's stored default. */
  isDefault: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const dragKeyRef = useRef<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  useCloseOnOutsideClick(detailsRef);

  const listed = pickerColumns(columns, resolved);
  const visibleKeys = resolved.filter((column) => !column.alwaysVisible).map((column) => column.key);
  const isVisible = (key: string) => visibleKeys.includes(key);

  function toggle(key: string, checked: boolean) {
    // Appended rather than restored to its declared slot: the list the admin
    // is looking at *is* the order, so a column they just ticked should appear
    // where they can see it happen, not somewhere up the table.
    onChange(checked ? [...visibleKeys, key] : visibleKeys.filter((k) => k !== key));
  }

  function handleDrop(targetKey: string) {
    const dragKey = dragKeyRef.current;
    dragKeyRef.current = null;
    setDragOverKey(null);
    if (!dragKey || dragKey === targetKey || !isVisible(dragKey) || !isVisible(targetKey)) return;

    const next = [...visibleKeys];
    next.splice(next.indexOf(dragKey), 1);
    next.splice(next.indexOf(targetKey), 0, dragKey);
    onChange(next);
  }

  return (
    <details ref={detailsRef} className={`${styles.dropdownWrapper} ${styles.columnPicker}`}>
      <summary className={styles.dropdownSummary}>
        Columns: {visibleKeys.length}/{columns.filter((c) => !c.alwaysVisible).length}
      </summary>
      <div className={styles.dropdownPanel}>
        <div className={styles.columnPickerList}>
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
                draggable={checked}
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
                <span className={styles.columnDragHandle}>{checked ? "⠿" : "  "}</span>
                <input type="checkbox" checked={checked} onChange={(e) => toggle(column.key, e.target.checked)} />
                {column.header}
              </label>
            );
          })}

          {/* Listed but not editable, so the picker describes the whole table
              rather than implying these columns don't exist. */}
          {columns
            .filter((column) => column.alwaysVisible)
            .map((column) => (
              <span key={column.key} className={`${styles.columnRow} ${styles.columnRowFixed}`}>
                <span className={styles.columnDragHandle}>{"  "}</span>
                <input type="checkbox" checked disabled aria-label={`${column.key} (always shown)`} />
                {column.header || column.key} <em>(always shown)</em>
              </span>
            ))}
        </div>

        <div className={styles.columnPickerActions}>
          <button
            type="button"
            disabled={saving || isDefault}
            onClick={() => {
              setSaveError(null);
              startSaving(async () => {
                try {
                  await onSaveDefault(visibleKeys);
                } catch (e) {
                  setSaveError(e instanceof Error ? e.message : "Couldn't save.");
                }
              });
            }}
          >
            Save as my default
          </button>
          <button type="button" onClick={onReset} disabled={saving}>
            Reset
          </button>
          {saveError && <span style={{ color: "var(--error)" }}>{saveError}</span>}
        </div>
      </div>
    </details>
  );
}
