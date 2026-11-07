"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  bulkDeleteReferences,
  bulkRestoreReferences,
  deleteReference,
  restoreReference,
  updateReferenceKey,
  updateReferenceShort,
} from "@/app/actions/references";
import { formatDate } from "@/lib/format-date";
import { type ReferencesFilters, buildReferencesQueryString } from "@/lib/references-query";
import { sameCols, type TablePrefs } from "@/lib/table-query";
import { useTableFilters } from "@/components/table/use-table-filters";
import { useRevealedRows } from "@/components/table/use-revealed-rows";
import { useRowStatus } from "@/components/table/use-row-status";
import { useRowSelection } from "@/components/table/use-row-selection";
import {
  BulkToolbar,
  SelectAllHeader,
  SelectRowCheckbox,
  softDeleteBulkActions,
  type BulkAction,
} from "@/components/table/BulkToolbar";
import { FilterHelp } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { registryColumns, resolveColumns, type ColumnBody, type ColumnSpec } from "@/components/table/column-spec";
import type { AdminColumnKey } from "@/lib/admin-table-columns";
import { saveTableColumns } from "@/app/actions/table-preferences";
import {
  CellError,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
} from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";
import styles from "./ReferencesTable.module.css";

// docs/CITATIONS.md, "Pages" — /references, built from the shared table kit
// as /tags is: a `*-query.ts` and the kit's hooks, never a fresh `<table>`
// (CLAUDE.md). Every column sorts in Postgres; Author(s), Year and Title are
// fields of each record's CSL-JSON and go through the `reference_listing`
// view.
//
// Two tiers on one page, as /tags has: any member may read the library, and
// AUTHOR and above may change it (`canWrite`).

export type ReferenceTableRow = {
  id: string;
  key: string;
  short: string;
  people: string;
  year: number | null;
  title: string;
  file: { slug: string; title: string } | null;
  createdByName: string;
  createdAt: Date;
  deletedAt: Date | null;
  deleted: boolean;
};

const SORTABLE_KEYS = ["key", "short", "people", "year", "title", "file", "created", "createdBy", "deletedAt", "deleted"] as const;

export default function ReferencesTable({
  rows,
  totalCount,
  filters,
  prefs,
  canWrite,
}: {
  rows: ReferenceTableRow[];
  totalCount: number;
  filters: ReferencesFilters;
  prefs: TablePrefs;
  /** AUTHOR and above: may rename, abbreviate, delete and restore (docs/PERMISSIONS.md). */
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildReferencesQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  const bulkActions: BulkAction<ReferenceTableRow>[] = canWrite
    ? softDeleteBulkActions<ReferenceTableRow>("references", bulkDeleteReferences, bulkRestoreReferences)
    : [];

  function run(row: ReferenceTableRow, action: () => Promise<unknown>, failure: string) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          await action();
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : failure);
      }
    });
  }

  function handleRenameKey(row: ReferenceTableRow) {
    // A prompt(), as a tag's rename is: rare, and wide in effect. The old key
    // keeps answering, which the prompt says so nobody fears a broken link.
    const next = window.prompt(`Rename the key "${row.key}". Links and exports that use the old key keep working.`, row.key);
    if (next === null || next.trim() === row.key) return;
    run(row, () => updateReferenceKey(row.id, next), "Failed to rename the key.");
  }

  function handleShort(row: ReferenceTableRow) {
    const next = window.prompt(`The abbreviation a short citation of "${row.title}" shows, such as BU. Leave it empty for none.`, row.short);
    if (next === null || next.trim() === row.short) return;
    run(row, () => updateReferenceShort(row.id, next), "Failed to set the abbreviation.");
  }

  function handleDeleteToggle(row: ReferenceTableRow) {
    run(
      row,
      async () => {
        if (row.deleted) {
          await restoreReference(row.id);
        } else {
          await deleteReference(row.id);
          revealRow(row);
        }
      },
      "Failed to update the reference.",
    );
  }

  const columnBodies: Record<AdminColumnKey<"references">, ColumnBody<ReferenceTableRow>> = {
    key: {
      sortKey: "key",
      nowrap: true,
      // Links to the reference's own page, which is what a key *is* from a
      // published post and from an export.
      cell: (row) => (
        <span className={styles.keyCell}>
          <Link href={`/references/${row.key}`}>{row.key}</Link>
          {canWrite && !row.deleted && (
            <button
              type="button"
              className={styles.editButton}
              onClick={() => handleRenameKey(row)}
              disabled={pending}
              title={`Rename the key ${row.key}`}
              aria-label={`Rename key ${row.key}`}
            >
              ✎
            </button>
          )}
        </span>
      ),
    },
    short: {
      sortKey: "short",
      nowrap: true,
      cell: (row) => (
        <span className={styles.keyCell}>
          {row.short ? row.short : <span className={styles.missing}>none</span>}
          {canWrite && !row.deleted && (
            <button
              type="button"
              className={styles.editButton}
              onClick={() => handleShort(row)}
              disabled={pending}
              title={`Set the abbreviation of ${row.key}`}
              aria-label={`Set abbreviation of ${row.key}`}
            >
              ✎
            </button>
          )}
        </span>
      ),
    },
    people: { sortKey: "people", cell: (row) => row.people },
    year: { sortKey: "year", nowrap: true, cell: (row) => (row.year === null ? "" : String(row.year)) },
    title: { sortKey: "title", cell: (row) => row.title },
    file: {
      sortKey: "file",
      cell: (row) => (row.file ? <Link href={`/pdf/${row.file.slug}`}>{row.file.title}</Link> : ""),
    },
    created: { sortKey: "created", nowrap: true, cell: (row) => formatDate(row.createdAt, "yyyy-MM-dd HH:mm") },
    createdBy: { sortKey: "createdBy", nowrap: true, cell: (row) => row.createdByName },
    deletedAt: {
      sortKey: "deletedAt",
      nowrap: true,
      cell: (row) => (row.deletedAt ? formatDate(row.deletedAt, "yyyy-MM-dd HH:mm") : ""),
    },
  };
  const columns: ColumnSpec<ReferenceTableRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox checked={selectedIds.has(row.id)} onChange={() => toggleRow(row.id)} label={`reference ${row.key}`} />
      ),
    },
    ...registryColumns("references", columnBodies),
    {
      key: "deleted",
      alwaysVisible: true,
      header: "Deleted",
      renderHeader: () => <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />,
      cell: (row) => (
        <RowActionButton deleted={row.deleted} noun="reference" disabled={pending || !canWrite} onClick={() => handleDeleteToggle(row)} />
      ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search key, title or author …"
          label="Search key, title or author"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<ReferencesFilters>)}
          onReset={() => navigate({ cols: null } as Partial<ReferencesFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("references", cols);
            navigate({ cols: null } as Partial<ReferencesFilters>);
          }}
          isDefault={sameCols(filters.cols, prefs.cols)}
        />
      </div>

      <BulkToolbar
        selectedRows={selectedRows}
        actions={bulkActions}
        runWithStatus={runWithStatusMany}
        onDeleted={revealRows}
        onDone={(ok) => {
          if (ok) clearSelection();
          router.refresh();
        }}
      />

      <div className={adminStyles.tableScroll}>
        <table className={adminStyles.table}>
          <thead>
            <ColumnHeaderRow columns={visibleColumns} sort={filters.sort} onSort={handleSort} />
          </thead>
          <tbody>
            {displayRows.length === 0 && <EmptyRow colSpan={visibleColumns.length} message="No references matching the criteria." />}
            {displayRows.map((row) => (
              <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
                <ColumnCells row={row} columns={visibleColumns} statusClass={rowStatusClass(row.id)} statusTitle={rowStatusTitle(row.id)} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CellError message={error} />

      <PaginationBar
        totalCount={totalCount}
        page={filters.page}
        pageSize={filters.pageSize}
        noun="references"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over a reference's key, abbreviation, title, authors and editors, where it appeared and its year."
        filters={[]}
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts. <strong>Author(s)</strong>, <strong>Year</strong> and <strong>Title</strong> are fields of each
            record and go through the <code>reference_listing</code> view. A reference is held once: importing a work whose DOI or
            ISBN the library already has is refused, naming the record that has it, and a deleted one keeps its identifiers, so its
            duplicate is caught and it can be restored instead. A <strong>key</strong> is permanent once used: renaming one leaves
            the old key answering. An empty <strong>Abbr.</strong> means a short citation of the work falls back to its
            author-date form. Adding, renaming, deleting and restoring are for AUTHOR and above (docs/PERMISSIONS.md).
          </p>
        }
      />
    </>
  );
}
