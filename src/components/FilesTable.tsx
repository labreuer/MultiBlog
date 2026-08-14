"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  bulkDeleteFiles,
  bulkRestoreFiles,
  bulkSetFileVisibility,
  deleteFile,
  restoreFile,
  updateFileVisibility,
} from "@/app/actions/files";
import { formatDate } from "@/lib/format-date";
import { formatBytes } from "@/lib/file-format";
import { DocVisibility } from "@/generated/prisma/enums";
import { type FilesFilters, buildFilesQueryString } from "@/lib/files-query";
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
import { AuthorFilterPanel, type AuthorOption } from "@/components/table/AuthorFilterPanel";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { resolveColumns, type ColumnSpec } from "@/components/table/column-spec";
import { saveTableColumns } from "@/app/actions/table-preferences";
import {
  CellError,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  SelectCell,
  ShowDeletedToggle,
} from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";
import styles from "./FilesTable.module.css";

// PLAN.md §19 — /files, built from the shared table kit exactly as /docs is.
// A new admin table means a `*-query.ts` and the kit's hooks, never a fresh
// `<table>` (CLAUDE.md), and every column here sorts in Postgres: the two that
// no plain ORDER BY could reach (Author(s), Annotations) go through the
// `file_metrics` view.

export type FileRow = {
  id: string;
  slug: string;
  title: string;
  filename: string;
  authors: string;
  visibility: DocVisibility;
  /** Null for a file whose upload-time parse never recorded one. */
  pageCount: number | null;
  byteSize: number;
  annotationCount: number;
  createdAt: Date;
  updatedAt: Date;
  updatedByName: string;
  deletedAt: Date | null;
  deleted: boolean;
  canManage: boolean;
};

const SORTABLE_KEYS = [
  "title",
  "filename",
  "authors",
  "visibility",
  "pages",
  "size",
  "annotations",
  "created",
  "slug",
  "updatedAt",
  "updatedBy",
  "deletedAt",
  "deleted",
] as const;

export default function FilesTable({
  rows,
  totalCount,
  filters,
  prefs,
  isAdmin,
  authorOptions,
}: {
  rows: FileRow[];
  totalCount: number;
  filters: FilesFilters;
  prefs: TablePrefs;
  /** Whether to render the ADMIN-only "Show all files" checkbox (docs/PERMISSIONS.md). */
  isAdmin: boolean;
  authorOptions: AuthorOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildFilesQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  const bulkActions: BulkAction<FileRow>[] = [
    {
      kind: "select",
      key: "visibility",
      label: "Set visibility",
      options: Object.values(DocVisibility),
      applicableTo: (row) => !row.deleted && row.canManage,
      run: (ids, value) => bulkSetFileVisibility(ids, value as DocVisibility),
    },
    ...softDeleteBulkActions<FileRow>("files", bulkDeleteFiles, bulkRestoreFiles),
  ];

  const columns: ColumnSpec<FileRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`file ${row.title}`}
        />
      ),
    },
    {
      key: "title",
      header: "Title",
      sortKey: "title",
      // Links by slug, not id — unlike /docs, whose /doc/[slug] route resolves
      // an id too (resolveDocParam). /pdf/[slug] takes a slug only, so the id
      // would 404.
      cellProps: (row) => ({
        className: styles.titleCell,
        onClick: (e) => {
          if (!(e.target instanceof Element) || !e.target.closest("a")) router.push(`/pdf/${row.slug}`);
        },
      }),
      cell: (row) => <Link href={`/pdf/${row.slug}`}>{row.title}</Link>,
    },
    {
      key: "filename",
      header: "Filename",
      sortKey: "filename",
      cellProps: () => ({ className: styles.filenameCell }),
      cell: (row) => row.filename,
    },
    { key: "authors", header: "Author(s)", sortKey: "authors", cell: (row) => row.authors },
    {
      key: "visibility",
      header: "Visibility",
      sortKey: "visibility",
      cell: (row) => (
        <SelectCell
          value={row.visibility}
          options={Object.values(DocVisibility)}
          disabled={row.deleted || !row.canManage}
          save={(next) => updateFileVisibility(row.id, next)}
          failureMessage="Failed to update visibility."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "pages",
      header: "Pages",
      sortKey: "pages",
      nowrap: true,
      cellProps: () => ({ className: styles.numeric }),
      cell: (row) => (row.pageCount === null ? "" : row.pageCount.toLocaleString()),
    },
    {
      key: "size",
      header: "Size",
      sortKey: "size",
      nowrap: true,
      cellProps: () => ({ className: styles.numeric }),
      // Sorted on the raw byte count in Postgres, displayed rounded — so
      // "1.2 MB" and "1.3 MB" order by their real sizes rather than by string.
      cell: (row) => formatBytes(row.byteSize),
    },
    {
      key: "annotations",
      header: "Annotations",
      sortKey: "annotations",
      nowrap: true,
      cellProps: () => ({ className: styles.numeric }),
      cell: (row) => (row.annotationCount === 0 ? "" : row.annotationCount.toLocaleString()),
    },
    {
      key: "created",
      header: "Added",
      sortKey: "created",
      nowrap: true,
      // The default sort (files-query.ts): a file is written once, so "what
      // arrived recently" is the useful landing view — the opposite of /docs,
      // where updatedAt leads because a doc's whole life is edits.
      cell: (row) => formatDate(row.createdAt, "yyyy-MM-dd HH:mm"),
    },
    { key: "slug", header: "Slug", sortKey: "slug", defaultHidden: true, cell: (row) => row.slug },
    {
      key: "updatedAt",
      header: "Updated",
      sortKey: "updatedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => formatDate(row.updatedAt, "yyyy-MM-dd HH:mm"),
    },
    {
      key: "updatedBy",
      header: "Updated by",
      sortKey: "updatedBy",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => row.updatedByName,
    },
    {
      key: "deletedAt",
      header: "Deleted at",
      sortKey: "deletedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => (row.deletedAt ? formatDate(row.deletedAt, "yyyy-MM-dd HH:mm") : ""),
    },
    {
      key: "deleted",
      alwaysVisible: true,
      header: "Deleted",
      renderHeader: () => <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />,
      cell: (row) => (
        <RowActionButton
          deleted={row.deleted}
          noun="file"
          disabled={pending || !row.canManage}
          onClick={() => handleDeleteToggle(row)}
        />
      ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  function handleDeleteToggle(row: FileRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreFile(row.id);
          } else {
            await deleteFile(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update file.");
      }
    });
  }

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search title or filename …"
          label="Search title or filename"
        />
        <AuthorFilterPanel
          options={authorOptions}
          selected={filters.authors}
          mode={filters.authorMode}
          onChange={(next) => updateFilters(next)}
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<FilesFilters>)}
          onReset={() => navigate({ cols: null } as Partial<FilesFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("files", cols);
            navigate({ cols: null } as Partial<FilesFilters>);
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
            {displayRows.length === 0 && (
              <EmptyRow colSpan={visibleColumns.length} message="No files matching the criteria." />
            )}
            {displayRows.map((row) => (
              <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
                <ColumnCells
                  row={row}
                  columns={visibleColumns}
                  statusClass={rowStatusClass(row.id)}
                  statusTitle={rowStatusTitle(row.id)}
                />
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
        noun="files"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />
      {isAdmin && (
        <p className={styles.showAllFilesRow}>
          <label>
            <input
              type="checkbox"
              checked={filters.showAllFiles}
              onChange={(e) => updateFilters({ showAllFiles: e.target.checked })}
            />{" "}
            Show all files (bypasses PRIVATE authorship for this listing only)
          </label>
        </p>
      )}

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the file's title and its original filename."
        filters={[
          {
            param: "authors",
            meaning: (
              <>
                Comma-separated user slugs, combined per <code>authorMode</code>. A slug that no longer names a live
                ADMIN/EDITOR/AUTHOR account is dropped rather than honoured.
              </>
            ),
            control: "Authors dropdown",
          },
          {
            param: "authorMode",
            meaning: (
              <>
                How <code>authors</code> is applied. <code>ANY</code> (the default), <code>ALL</code>,{" "}
                <code>EXACTLY</code>, <code>NONE</code> — identical semantics to /docs. Ignored while nothing is
                checked.
              </>
            ),
            control: "Match dropdown, at the foot of the Authors panel",
          },
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts. <strong>Author(s)</strong> and <strong>Annotations</strong> go through the{" "}
            <code>file_metrics</code> view — a byline joined in SQL across a file&apos;s authors, and a count that
            excludes deleted and still-private draft annotations, neither of which a plain <code>ORDER BY</code> could
            name. <strong>Size</strong> sorts on the raw byte count even though it prints rounded, and{" "}
            <strong>Pages</strong> and Size are both stored columns recorded once at upload, so sorting by either costs
            no more than sorting by a date. <strong>Slug</strong>, <strong>Updated</strong>,{" "}
            <strong>Updated by</strong> and <strong>Deleted at</strong> are hidden by default (Columns picker, above).
            This listing shows every <strong>SHARED</strong> file to an ADMIN or EDITOR, plus the{" "}
            <strong>PRIVATE</strong> files you carry a byline on — so an AUTHOR sees only their own. ADMIN accounts also
            get a &quot;Show all files&quot; checkbox above, which adds everyone else&apos;s PRIVATE files for the
            current visit; opening one still needs a byline on it (docs/PERMISSIONS.md). Deleting is a soft delete: the
            row is hidden and restorable, and the stored bytes are never swept, since another file may share them.
          </p>
        }
      />
    </>
  );
}
