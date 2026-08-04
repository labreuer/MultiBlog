"use client";

import type { ReactNode, RefObject } from "react";
import type { SortColumn } from "@/lib/table-sort";
import type { ColumnSpec } from "./column-spec";
import { SortHeader } from "./TableControls";
import styles from "./AdminTable.module.css";

// Renders a resolved ColumnSpec list as a header row and as each row's cells
// (PLAN.md §16i). The kit owns the <th>/<td> so it can decide which columns
// appear and in what order; the table still owns everything inside them.
//
// Two things it does that a table can no longer do for itself once order is
// user-controlled:
//
//   - **The row-status border goes on whichever column renders first**, not on
//     a column the table names. §16f defines it as "the row's first <td>", and
//     with reordering in play the first <td> is only known here.
//   - **colSpan is the resolved column count**, so the empty-state row spans
//     the table however many columns are showing — the literal `colSpan={11}`
//     each table used to carry is exactly the thing visibility breaks.

export function ColumnHeaderRow<Row, K extends string>({
  columns,
  sort,
  onSort,
}: {
  columns: ColumnSpec<Row>[];
  sort: SortColumn<K>[];
  onSort: (key: K, addToSort: boolean) => void;
}) {
  return (
    <tr style={{ textAlign: "left" }}>
      {columns.map((column) =>
        // A column with its own header markup (the deleted column's icon
        // button) returns a complete <th>; everything else gets the standard
        // sortable or plain one.
        column.renderHeader ? (
          <ColumnHeaderSlot key={column.key}>{column.renderHeader()}</ColumnHeaderSlot>
        ) : column.sortKey ? (
          <SortHeader
            key={column.key}
            sortKey={column.sortKey as K}
            sort={sort}
            onSort={onSort}
            nowrap={column.nowrap}
            className={column.headerClassName}
            title={column.headerTitle}
            thRef={column.thRef}
          >
            {column.header}
          </SortHeader>
        ) : (
          <th
            key={column.key}
            className={[column.nowrap ? styles.nowrapHeaderCell : styles.headerCell, column.headerClassName ?? ""]
              .filter(Boolean)
              .join(" ")}
            title={column.headerTitle}
          >
            {column.header}
          </th>
        ),
      )}
    </tr>
  );
}

// A pass-through so `renderHeader`'s own <th> can still carry the React key
// the map needs, without the column having to thread one itself.
function ColumnHeaderSlot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function ColumnCells<Row>({
  row,
  columns,
  statusClass,
  statusTitle,
}: {
  row: Row;
  columns: ColumnSpec<Row>[];
  /** The row-status border classes for this row (§16f). */
  statusClass: string;
  /** Why this row is red, when a bulk action said so. */
  statusTitle?: string;
}) {
  return (
    <>
      {columns.map((column, index) => {
        const extra = column.cellProps?.(row);
        const base = column.nowrap ? styles.nowrapCell : styles.cell;
        // Only the first rendered cell carries the status border, whichever
        // column that turns out to be after reordering.
        const className = [base, index === 0 ? statusClass : "", extra?.className ?? ""].filter(Boolean).join(" ");
        return (
          <td
            key={column.key}
            className={className}
            title={index === 0 ? statusTitle : undefined}
            onClick={extra?.onClick}
          >
            {column.cell(row)}
          </td>
        );
      })}
    </>
  );
}

export type { RefObject };
