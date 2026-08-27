"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  deleteDoc,
  restoreDoc,
  bulkDeleteDocs,
  bulkRestoreDocs,
  bulkSetDocVisibility,
  updateDocVisibility,
} from "@/app/actions/docs";
import { formatDate } from "@/lib/format-date";
import { DocVisibility } from "@/generated/prisma/enums";
import { type DocsFilters, buildDocsQueryString } from "@/lib/docs-query";
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
import styles from "./DocsTable.module.css";

export type DocRow = {
  id: string;
  slug: string;
  title: string;
  authors: string;
  visibility: DocVisibility;
  createdAt: Date;
  updatedAt: Date;
  updatedByName: string;
  // Character count, read straight off Doc.proseJsonLength — a stored column
  // kept current by a Postgres trigger, not something computed here, so a
  // doc's full body never has to reach this component to show its length
  // (PLAN.md §16l).
  length: number;
  // Live, non-DRAFT annotations on the doc, replies included — read off
  // doc_metrics.annotation_count, a *filtered* count Prisma's `_count` has no
  // way to express in an orderBy. The /files twin of this column is
  // FileRow.annotationCount, counting the same thing the same way.
  annotationCount: number;
  deletedAt: Date | null;
  deleted: boolean;
  canEdit: boolean;
};

const SORTABLE_KEYS = [
  "title",
  "authors",
  "visibility",
  "created",
  "length",
  "annotations",
  "slug",
  "updatedAt",
  "updatedBy",
  "deletedAt",
  "deleted",
] as const;

export default function DocsTable({
  rows,
  totalCount,
  filters,
  prefs,
  isAdmin,
  authorOptions,
}: {
  rows: DocRow[];
  totalCount: number;
  filters: DocsFilters;
  prefs: TablePrefs;
  /** Whether to render the ADMIN-only "Show all docs" checkbox (docs/PERMISSIONS.md).
   * Without it the table lists what this viewer can already reach: their own
   * byline-authored docs, plus every SHARED doc for an ADMIN/EDITOR. */
  isAdmin: boolean;
  /** Every ADMIN/EDITOR/AUTHOR, for the Authors filter panel (src/lib/author-filter.ts). */
  authorOptions: AuthorOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildDocsQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  const bulkActions: BulkAction<DocRow>[] = [
    {
      kind: "select",
      key: "visibility",
      label: "Set visibility",
      options: Object.values(DocVisibility),
      // A deleted doc keeps whatever visibility it had: changing it would be
      // an edit to a row the admin has already taken out of circulation.
      applicableTo: (row) => !row.deleted && row.canEdit,
      run: (ids, value) => bulkSetDocVisibility(ids, value as DocVisibility),
    },
    ...softDeleteBulkActions<DocRow>("docs", bulkDeleteDocs, bulkRestoreDocs),
  ];

  // Declared in the order they render by default; `?cols=` reorders and hides
  // the movable ones from here (§16i). Built in the component body rather than
  // at module scope so a cell stays an ordinary React expression closing over
  // the router, the selection and the pending state.
  const columns: ColumnSpec<DocRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`doc ${row.title}`}
        />
      ),
    },
    {
      key: "title",
      header: "Title",
      sortKey: "title",
      // The whole cell is the click target, not just the link in it.
      cellProps: (row) => ({
        className: styles.titleCell,
        onClick: (e) => {
          if (!(e.target instanceof Element) || !e.target.closest("a")) router.push(`/doc/${row.id}`);
        },
      }),
      cell: (row) => <Link href={`/doc/${row.id}`}>{row.title}</Link>,
    },
    {
      key: "edit",
      header: "Edit",
      cell: (row) => row.canEdit && <Link href={`/doc/${row.id}/edit`}>edit</Link>,
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
          disabled={row.deleted || !row.canEdit}
          save={(next) => updateDocVisibility(row.id, next)}
          failureMessage="Failed to update visibility."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "updatedAt",
      header: "Updated",
      sortKey: "updatedAt",
      nowrap: true,
      // The ordinary Postgres row-update timestamp — distinct from Length,
      // which only tracks the body's own trigger-maintained cache. Shown by
      // default in Created's old spot, and the default sort key (DEFAULT_SORT,
      // docs-query.ts): "what changed recently" is a more useful landing view
      // for this table than "what was made first".
      cell: (row) => formatDate(row.updatedAt, "yyyy-MM-dd HH:mm"),
    },
    {
      key: "updatedBy",
      header: "Updated by",
      sortKey: "updatedBy",
      nowrap: true,
      // Paired with Updated and shown by default alongside it, the same way
      // /posts shows "Last edit by" next to "Last edit at" — the timestamp on
      // its own doesn't answer who, and this table now leads with recency.
      // Blank for a doc nothing has updated since the column existed.
      cell: (row) => row.updatedByName,
    },
    {
      key: "length",
      header: "Length",
      sortKey: "length",
      nowrap: true,
      cell: (row) => row.length.toLocaleString(),
    },
    {
      key: "annotations",
      header: "Annotations",
      sortKey: "annotations",
      nowrap: true,
      // Off by default (§16i/§16m), unlike /files' identically-named column,
      // which is shown: a PDF is something people mark up and the count is
      // most of what /files has to say about one, where /docs already leads
      // with recency and authorship and most docs carry no annotations at all.
      // Declared here rather than down with the default-hidden Doc columns
      // because this is where it renders once turned on and reordered — next
      // to Length, the other derived measure of the document.
      defaultHidden: true,
      // Blank rather than "0" for a doc nobody has annotated, the same way
      // /files and /keywords print their counts: a column of zeroes reads as
      // noise, and what an admin turns this on for is which docs have
      // discussion on them.
      cell: (row) => (row.annotationCount === 0 ? "" : row.annotationCount.toLocaleString()),
    },
    // Defaulted hidden (§16l/§16i): real Doc columns available on request.
    // slug is otherwise unused here (Title/Edit link on row.id). created
    // moved here, defaulted hidden, when updatedAt took its old spot above.
    { key: "slug", header: "Slug", sortKey: "slug", defaultHidden: true, cell: (row) => row.slug },
    {
      key: "created",
      header: "Created",
      sortKey: "created",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => formatDate(row.createdAt, "yyyy-MM-dd HH:mm"),
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
        <RowActionButton deleted={row.deleted} noun="doc" disabled={pending} onClick={() => handleDeleteToggle(row)} />
      ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  function handleDeleteToggle(row: DocRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreDoc(row.id);
          } else {
            await deleteDoc(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update doc.");
      }
    });
  }

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox value={searchDraft} onChange={onSearchChange} placeholder="Search title …" label="Search title" />
        <AuthorFilterPanel
          options={authorOptions}
          selected={filters.authors}
          mode={filters.authorMode}
          onChange={(next) => updateFilters(next)}
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          // navigate, not updateFilters: showing or moving a column doesn't
          // change which rows match, so it has no business resetting to page 1.
          onChange={(cols) => navigate({ cols } as Partial<DocsFilters>)}
          onReset={() => navigate({ cols: null } as Partial<DocsFilters>)}
          // Saving writes the preference, then drops ?cols= so the URL stops
          // overriding the thing it was just used to author.
          onSaveDefault={async (cols) => {
            await saveTableColumns("docs", cols);
            navigate({ cols: null } as Partial<DocsFilters>);
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
              <EmptyRow colSpan={visibleColumns.length} message="No docs matching the criteria." />
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
        noun="docs"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />
      {isAdmin && (
        <p className={styles.showAllDocsRow}>
          <label>
            <input
              type="checkbox"
              checked={filters.showAllDocs}
              onChange={(e) => updateFilters({ showAllDocs: e.target.checked })}
            />{" "}
            Show all docs (bypasses PRIVATE authorship for this listing only)
          </label>
        </p>
      )}

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the doc title."
        filters={[
          {
            param: "authors",
            meaning: (
              <>
                Comma-separated user slugs, combined per <code>authorMode</code>. A slug that no longer names a live
                ADMIN/EDITOR/AUTHOR account is dropped rather than honoured, so a stale bookmark widens back to the
                unfiltered listing instead of going blank.
              </>
            ),
            control: "Authors dropdown",
          },
          {
            param: "authorMode",
            meaning: (
              <>
                How <code>authors</code> is applied. <code>ANY</code> (the default) — at least one of the checked
                authors. <code>ALL</code> — every one of them, others allowed. <code>EXACTLY</code> — that byline and
                nobody else. <code>NONE</code> — none of them, including rows with no byline at all. Ignored while
                nothing is checked.
              </>
            ),
            control: "Match dropdown, at the foot of the Authors panel",
          },
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts except <strong>Edit</strong>, which is a link rather than a value.{" "}
            <strong>Author(s)</strong> and <strong>Annotations</strong> go through the <code>doc_metrics</code>{" "}
            view — the byline joined in SQL across a doc&apos;s authors, and a count that excludes deleted and
            still-private draft annotations, neither of which a plain <code>ORDER BY</code> could name. That count is
            every live remark on the doc rather than every thread: a reply counts as its own annotation, the same way
            /files counts them. <strong>Length</strong> is a
            stored character count of the document body, measured in Postgres and kept current by a trigger, so sorting
            by it costs no more than sorting by a date (PLAN.md §16l). <strong>Annotations</strong>,{" "}
            <strong>Slug</strong>, <strong>Created</strong> and <strong>Deleted at</strong> are hidden by default
            (Columns picker, above) — sorting by one of them from a hand-edited URL still works while it is
            hidden. This listing shows every <strong>SHARED</strong> doc to an ADMIN or EDITOR, plus the{" "}
            <strong>PRIVATE</strong> docs you carry a
            byline on. ADMIN accounts also get a &quot;Show all docs&quot; checkbox above, which adds everyone
            else&apos;s PRIVATE docs for the current visit; opening one still needs a byline on it (docs/PERMISSIONS.md).
            The <strong>Authors</strong> filter narrows this listing; it never widens it. Without &quot;Show all
            docs&quot; the listing is still your own bylines plus every SHARED doc, so filtering on someone else&apos;s
            name returns the SHARED docs they co-author and not their PRIVATE ones — and your own name under{" "}
            <code>NONE</code> is a quick &quot;docs I&apos;m not on&quot;. A byline naming a deleted account still
            counts for <code>EXACTLY</code>, matching what the Author(s) column prints, so such a doc can&apos;t be
            matched exactly by the remaining authors alone.
          </p>
        }
      />
    </>
  );
}
