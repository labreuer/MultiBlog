"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  bulkDeleteTags,
  bulkRestoreTags,
  deleteTag,
  renameTag,
  restoreTag,
} from "@/app/actions/tags";
import { formatDate } from "@/lib/format-date";
import { type TagsFilters, buildTagsQueryString } from "@/lib/tags-query";
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
import { resolveColumns, type ColumnSpec } from "@/components/table/column-spec";
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
import styles from "./TagsTable.module.css";

// PLAN.md §20d — /tags, built from the shared table kit exactly as /files
// and /docs are. A new admin table means a `*-query.ts` and the kit's hooks,
// never a fresh `<table>` (CLAUDE.md), and every column here sorts in
// Postgres: the six that no plain ORDER BY could reach go through the
// `tag_metrics` view.
//
// The one thing this table has that no other does is **two permission tiers on
// one page**. Browsing the vocabulary is AUTHOR-and-up like every other admin
// listing; *editing* a term — renaming it, deleting it — is ADMIN/EDITOR,
// because a term is shared vocabulary and renaming one rewrites every chip
// site-wide. `canCurate` carries that distinction per render rather than per
// row: unlike /files' `canManage`, it does not vary by row, since a term has
// no owner to compare against.

export type TagRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  assignmentCount: number;
  docCount: number;
  postCount: number;
  fileCount: number;
  annotationCount: number;
  lastUsedAt: Date | null;
  createdByName: string;
  createdAt: Date;
  deletedAt: Date | null;
  deleted: boolean;
};

const SORTABLE_KEYS = [
  "name",
  "description",
  "assignments",
  "docs",
  "posts",
  "files",
  "annotations",
  "lastUsed",
  "createdBy",
  "created",
  "slug",
  "deletedAt",
  "deleted",
] as const;

export default function TagsTable({
  rows,
  totalCount,
  filters,
  prefs,
  canCurate,
}: {
  rows: TagRow[];
  totalCount: number;
  filters: TagsFilters;
  prefs: TablePrefs;
  /** ADMIN/EDITOR — may rename and delete terms (docs/PERMISSIONS.md, §20d). */
  canCurate: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildTagsQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  // No visibility/status bulk action to sit alongside these: a term has no
  // axis but existence.
  const bulkActions: BulkAction<TagRow>[] = canCurate
    ? softDeleteBulkActions<TagRow>("tags", bulkDeleteTags, bulkRestoreTags)
    : [];

  /** A numeric usage cell — blank at zero, so a full column of noughts doesn't drown the numbers that matter. */
  function count(value: number) {
    return value === 0 ? "" : value.toLocaleString();
  }

  const columns: ColumnSpec<TagRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`tag ${row.name}`}
        />
      ),
    },
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      // Links to the public browse page, not to an edit form: /tag/[slug]
      // is what a term *is* from every other surface, and an editor who wants
      // to see what a term has collected wants that page. The rename
      // affordance rides in the same cell rather than claiming a column of its
      // own, since it is ADMIN/EDITOR-only and would be an empty column for
      // everyone else.
      cell: (row) => (
        <span className={styles.nameCell}>
          <Link href={`/tag/${row.slug}`}>{row.name}</Link>
          {canCurate && !row.deleted && (
            <button
              type="button"
              className={styles.renameButton}
              onClick={() => handleRename(row)}
              disabled={pending}
              title={`Rename "${row.name}" — changes every chip site-wide`}
              aria-label={`Rename tag ${row.name}`}
            >
              ✎
            </button>
          )}
        </span>
      ),
    },
    {
      key: "description",
      header: "Description",
      sortKey: "description",
      cellProps: () => ({ className: styles.descriptionCell }),
      cell: (row) => row.description,
    },
    {
      key: "assignments",
      header: "Assignments",
      sortKey: "assignments",
      nowrap: true,
      cellProps: () => ({ className: styles.numeric }),
      // Distinct live acts of tagging — one act that tags three passages of one
      // doc (PR 2) counts once here and once under Docs, which is the
      // difference between "how often was this term applied" and "how many
      // things carry it".
      cell: (row) => count(row.assignmentCount),
    },
    {
      key: "docs",
      header: "Docs",
      sortKey: "docs",
      nowrap: true,
      defaultHidden: true,
      cellProps: () => ({ className: styles.numeric }),
      cell: (row) => count(row.docCount),
    },
    {
      key: "posts",
      header: "Posts",
      sortKey: "posts",
      nowrap: true,
      defaultHidden: true,
      cellProps: () => ({ className: styles.numeric }),
      cell: (row) => count(row.postCount),
    },
    {
      key: "files",
      header: "Files",
      sortKey: "files",
      nowrap: true,
      defaultHidden: true,
      cellProps: () => ({ className: styles.numeric }),
      cell: (row) => count(row.fileCount),
    },
    {
      key: "annotations",
      header: "Annotations",
      sortKey: "annotations",
      nowrap: true,
      defaultHidden: true,
      cellProps: () => ({ className: styles.numeric }),
      cell: (row) => count(row.annotationCount),
    },
    {
      key: "lastUsed",
      header: "Last used",
      sortKey: "lastUsed",
      nowrap: true,
      // The column that finds dead vocabulary: a term nobody has applied in a
      // year, or ever (blank), is the candidate for merging away.
      cell: (row) => (row.lastUsedAt ? formatDate(row.lastUsedAt, "yyyy-MM-dd HH:mm") : ""),
    },
    { key: "createdBy", header: "Created by", sortKey: "createdBy", nowrap: true, cell: (row) => row.createdByName },
    {
      key: "created",
      header: "Created at",
      sortKey: "created",
      nowrap: true,
      cell: (row) => formatDate(row.createdAt, "yyyy-MM-dd HH:mm"),
    },
    { key: "slug", header: "Slug", sortKey: "slug", defaultHidden: true, cell: (row) => row.slug },
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
          noun="tag"
          disabled={pending || !canCurate}
          onClick={() => handleDeleteToggle(row)}
        />
      ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  function handleDeleteToggle(row: TagRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreTag(row.id);
          } else {
            await deleteTag(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update tag.");
      }
    });
  }

  function handleRename(row: TagRow) {
    // A prompt() rather than an inline editor, deliberately: renaming a term is
    // rare, ADMIN/EDITOR-only, and site-wide in effect — the kit's SelectCell
    // pattern suits a value you change often and casually, which this is the
    // opposite of. The confirmation the prompt gives for free is the point.
    const next = window.prompt(`Rename "${row.name}" — this changes every chip site-wide.`, row.name);
    if (next === null || next.trim() === row.name) return;
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, () => renameTag(row.id, next));
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to rename tag.");
      }
    });
  }

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search name or description …"
          label="Search name or description"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<TagsFilters>)}
          onReset={() => navigate({ cols: null } as Partial<TagsFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("tags", cols);
            navigate({ cols: null } as Partial<TagsFilters>);
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
              <EmptyRow colSpan={visibleColumns.length} message="No tags matching the criteria." />
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
        noun="tags"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the term's name and its description."
        filters={[]}
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts. <strong>Assignments</strong>, <strong>Docs</strong>, <strong>Posts</strong>,{" "}
            <strong>Files</strong>, <strong>Annotations</strong> and <strong>Last used</strong> go through the{" "}
            <code>tag_metrics</code> view — filtered counts over live acts of tagging whose target is itself live,
            which a plain <code>ORDER BY</code> could not name and Prisma&apos;s <code>_count</code> could not filter.
            A term nobody has used has no view row at all, so it reads as zeroes and sorts last. Assignments counts{" "}
            <em>acts of tagging</em> while the four per-type columns count <em>things tagged</em>; the two diverge once
            one act can span several passages. The four per-type counts, <strong>Slug</strong> and{" "}
            <strong>Deleted at</strong> are hidden by default (Columns picker, above). Terms are shared vocabulary:
            anyone who may annotate can create and apply one, but <strong>renaming and deleting are ADMIN/EDITOR</strong>{" "}
            since both act on everyone else&apos;s tags (docs/PERMISSIONS.md). Deleting is a soft delete — the term
            stops drawing chips everywhere, and its assignments are kept intact so a restore brings them back.
          </p>
        }
      />
    </>
  );
}
