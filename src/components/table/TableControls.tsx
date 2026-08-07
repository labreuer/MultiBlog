"use client";

import { useEffect, useRef } from "react";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import { DATE_FORMATS, type DateFormat } from "@/lib/format-date";
import { PAGE_SIZE_OPTIONS, type PageSize } from "@/lib/table-query";
import type { SortColumn } from "@/lib/table-sort";
import styles from "./AdminTable.module.css";

// The controls every URL-driven admin table renders around its rows
// (PLAN.md §16d). Small components, not a <DataTable> — each table still
// writes its own <thead>/<tbody> and its own cells; what it stops writing is
// this.

export function sortIndicator<K extends string>(sort: SortColumn<K>[], key: K) {
  const idx = sort.findIndex((c) => c.key === key);
  if (idx === -1) return null;
  return (
    <>
      {" "}
      {sort[idx].dir === "asc" ? "▲" : "▼"}
      {idx > 0 && <sup>{idx + 1}</sup>}
    </>
  );
}

// Ctrl-click adds a column as a secondary/tertiary sort key rather than
// replacing the current one (nextSortColumns, shared with the pre-pagination
// tables' click semantics).
export function SortHeader<K extends string>({
  sortKey,
  sort,
  onSort,
  nowrap,
  className,
  title,
  thRef,
  children,
}: {
  sortKey: K;
  sort: SortColumn<K>[];
  onSort: (key: K, addToSort: boolean) => void;
  nowrap?: boolean;
  className?: string;
  title?: string;
  // Only PostsTable uses this, to measure the Title column and match its
  // search box to that width.
  thRef?: React.Ref<HTMLTableCellElement>;
  children: React.ReactNode;
}) {
  const base = nowrap ? styles.nowrapSortableHeaderCell : styles.sortableHeaderCell;
  return (
    <th
      ref={thRef}
      className={className ? `${base} ${className}` : base}
      title={title}
      onClick={(e) => onSort(sortKey, e.ctrlKey)}
    >
      {children}
      {sortIndicator(sort, sortKey)}
    </th>
  );
}

// The delete/restore column's header: a sortable black trash icon whose
// padding/border/background match the row buttons below it exactly, so the
// icons line up on their left edge.
export function DeletedSortHeader<K extends string>({
  sortKey,
  sort,
  onSort,
}: {
  sortKey: K;
  sort: SortColumn<K>[];
  onSort: (key: K, addToSort: boolean) => void;
}) {
  return (
    <th className={styles.headerCell}>
      <button
        type="button"
        onClick={(e) => onSort(sortKey, e.ctrlKey)}
        aria-label="Sort by deleted status"
        title="Sort by deleted status"
        className={styles.iconButton}
      >
        <IconTrash size={16} color="#000" style={{ verticalAlign: "middle" }} />
        {sortIndicator(sort, sortKey)}
      </button>
    </th>
  );
}

// Soft delete/restore double as each other's undo — no confirmation dialog;
// the row stays visible with the icon swapped, so a mis-click is one more
// click to reverse instead of a modal to dismiss.
export function RowActionButton({
  deleted,
  noun,
  disabled,
  onClick,
}: {
  deleted: boolean;
  noun: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const label = deleted ? `Restore ${noun}` : `Delete ${noun}`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`${styles.iconButton} ${deleted ? styles.iconButtonMuted : styles.iconButtonDanger}`}
    >
      {deleted ? <IconTrashOff size={16} /> : <IconTrash size={16} />}
    </button>
  );
}

export function CellError({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className={styles.cellError}>{message}</div>;
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  width,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  // Only for PostsTable, whose search box tracks the Title column's measured
  // width; everything else takes the stylesheet's min-width.
  width?: number;
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className={styles.searchInput}
      style={width ? { width } : undefined}
    />
  );
}

export function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly T[];
  selected: Set<T> | "ALL";
  onChange: (next: Set<T> | "ALL") => void;
}) {
  const summary = selected === "ALL" ? "All" : options.filter((o) => selected.has(o)).join(", ") || "All";
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // <details> has no native "close on outside click" behavior — only toggles
  // via its own <summary>. Set .open directly on the DOM node (rather than
  // lifting it into React state) since nothing else here needs to react to
  // open/closed.
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (detailsRef.current && !detailsRef.current.contains(e.target as Node)) {
        detailsRef.current.open = false;
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  return (
    <details ref={detailsRef} className={styles.dropdownWrapper}>
      <summary className={styles.dropdownSummary}>
        {label}: {summary}
      </summary>
      <div className={styles.dropdownPanel}>
        <label className={styles.dropdownOption}>
          <input type="checkbox" checked={selected === "ALL"} onChange={() => onChange("ALL")} /> All
        </label>
        {options.map((option) => (
          <label key={option} className={styles.dropdownOption}>
            <input
              type="checkbox"
              checked={selected !== "ALL" && selected.has(option)}
              onChange={(e) => {
                const current = selected === "ALL" ? new Set<T>() : new Set(selected);
                if (e.target.checked) current.add(option);
                else current.delete(option);
                onChange(current.size === 0 ? "ALL" : current);
              }}
            />{" "}
            {option}
          </label>
        ))}
      </div>
    </details>
  );
}

export function PaginationBar({
  totalCount,
  page,
  pageSize,
  noun,
  onPageChange,
  onPageSizeChange,
}: {
  totalCount: number;
  page: number;
  pageSize: PageSize;
  noun: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);

  return (
    <div className={styles.paginationBar}>
      <label>
        Rows per page:{" "}
        <select
          value={pageSize}
          aria-label="Rows per page"
          onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <span>
        {totalCount === 0
          ? `0 ${noun}`
          : `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, totalCount)} of ${totalCount}`}
      </span>
      <button type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1}>
        ◀ Prev
      </button>
      <span>
        Page {currentPage} of {totalPages}
      </span>
      <button type="button" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage >= totalPages}>
        Next ▶
      </button>
    </div>
  );
}

export function DateFormatSelect({
  value,
  onChange,
}: {
  value: DateFormat;
  onChange: (value: DateFormat) => void;
}) {
  return (
    <p className={styles.dateFormatRow}>
      <label>
        Date format:{" "}
        <select value={value} aria-label="Date format" onChange={(e) => onChange(e.target.value as DateFormat)}>
          {DATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </label>
    </p>
  );
}

export function ShowDeletedToggle({
  checked,
  onChange,
  label = "Show deleted rows",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Overridable so one component serves both footer checkboxes — DocsTable
   * renders a second with this set to its admin-only "Show all docs"
   * override (PLAN.md §12p). */
  label?: string;
}) {
  return (
    <p className={styles.showDeletedRow}>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    </p>
  );
}

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className={`${styles.cell} ${styles.emptyRow}`}>
        {message}
      </td>
    </tr>
  );
}
