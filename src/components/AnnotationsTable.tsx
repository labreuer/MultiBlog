"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { type DateFormat, formatDate } from "@/lib/format-date";
import type { AnnotationStatus } from "@/generated/prisma/enums";
import { type AnnotationsFilters, buildAnnotationsQueryString } from "@/lib/annotations-query";
import { sameCols, type TablePrefs } from "@/lib/table-query";
import {
  deleteAnnotation,
  restoreAnnotation,
  bulkDeleteAnnotations,
  bulkRestoreAnnotations,
} from "@/app/actions/annotations";
import { useTableFilters } from "@/components/table/use-table-filters";
import { useRevealedRows } from "@/components/table/use-revealed-rows";
import { useRowStatus } from "@/components/table/use-row-status";
import { useRowSelection } from "@/components/table/use-row-selection";
import {
  BulkToolbar,
  SelectAllHeader,
  SelectRowCheckbox,
  softDeleteBulkActions,
} from "@/components/table/BulkToolbar";
import { FilterHelp, deepLinkEntry } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { resolveColumns, type ColumnSpec } from "@/components/table/column-spec";
import { saveTableColumns } from "@/app/actions/table-preferences";
import {
  CellError,
  DateFormatSelect,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
} from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";

export type AnnotationRow = {
  id: string;
  docId: string;
  docSlug: string;
  docTitle: string;
  authorName: string;
  bodyText: string;
  // "" for a reply (only a root annotation is ever anchored) or a
  // document-level root (its mark is gone, PLAN.md §12h) — the table shows
  // "document-level" for that case, the only admin surface where the
  // distinction is visible at all (§12j).
  quote: string;
  isRoot: boolean;
  createdAt: Date;
  editedAt: Date | null;
  // DRAFT is excluded from this whole table (§13d — a private note, invisible
  // even to admins), so this is only ever LIVE or RAISED in practice.
  status: AnnotationStatus;
  raisedAt: Date | null;
  resolvedAt: Date | null;
  deletedAt: Date | null;
  deleted: boolean;
};

const SORTABLE_KEYS = [
  "doc",
  "author",
  "created",
  "edited",
  "status",
  "raisedAt",
  "resolvedAt",
  "deletedAt",
  "deleted",
] as const;

// A much smaller sibling of CommentsTable (PLAN.md §12j): no status/thread-
// status filters, no moderation buttons — the only action an annotation
// supports is Delete/Restore, already a per-row icon button.
export default function AnnotationsTable({
  rows,
  totalCount,
  filters,
  prefs,
}: {
  rows: AnnotationRow[];
  totalCount: number;
  filters: AnnotationsFilters;
  prefs: TablePrefs;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd HH:mm");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildAnnotationsQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  // Delete/restore only: §12j's decision that an annotation supports no other
  // action holds in bulk too.
  const bulkActions = softDeleteBulkActions<AnnotationRow>(
    "annotations",
    bulkDeleteAnnotations,
    bulkRestoreAnnotations,
  );

  function handleDeleteToggle(row: AnnotationRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreAnnotation(row.id);
          } else {
            await deleteAnnotation(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update annotation.");
      }
    });
  }

  // Declared in the order they render by default; `?cols=` reorders and hides
  // the movable ones from here (§16i).
  //
  // Unlike the other four tables, "Deleted" and the row action aren't the same
  // column here: "Deleted" is an ordinary sortable Yes/blank status column, and
  // the actual restore/delete button sits in its own unlabeled column after
  // it — that split predates this conversion and is preserved as-is. Only the
  // action column has to stay alwaysVisible; the status text is just a status.
  const columns: ColumnSpec<AnnotationRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`annotation by ${row.authorName}`}
        />
      ),
    },
    { key: "doc", header: "Doc", sortKey: "doc", cell: (row) => <Link href={`/doc/${row.docSlug}`}>{row.docTitle}</Link> },
    { key: "author", header: "Author", sortKey: "author", cell: (row) => row.authorName },
    { key: "body", header: "Body", cell: (row) => row.bodyText },
    {
      key: "quote",
      header: "Quote",
      cell: (row) => (!row.isRoot ? "" : row.quote ? `“${row.quote}”` : <em>document-level</em>),
    },
    // Shown by default, not hidden: unlike the columns below, this names a
    // real workflow state (RAISED means the doc's byline authors were
    // emailed, §13d) that otherwise has zero visibility anywhere in this
    // table.
    { key: "status", header: "Status", sortKey: "status", cell: (row) => row.status },
    {
      key: "created",
      header: "Created",
      sortKey: "created",
      nowrap: true,
      cell: (row) => formatDate(row.createdAt, dateFormat),
    },
    {
      key: "edited",
      header: "Edited",
      sortKey: "edited",
      nowrap: true,
      cell: (row) => (row.editedAt ? formatDate(row.editedAt, dateFormat) : ""),
    },
    { key: "deletedStatus", header: "Deleted", sortKey: "deleted", cell: (row) => (row.deleted ? "Yes" : "") },
    // Defaulted hidden (§16l/§16i): real Annotation columns, available on
    // request.
    {
      key: "raisedAt",
      header: "Raised at",
      sortKey: "raisedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => (row.raisedAt ? formatDate(row.raisedAt, dateFormat) : ""),
    },
    {
      key: "resolvedAt",
      header: "Resolved at",
      sortKey: "resolvedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => (row.resolvedAt ? formatDate(row.resolvedAt, dateFormat) : ""),
    },
    {
      key: "deletedAt",
      header: "Deleted at",
      sortKey: "deletedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => (row.deletedAt ? formatDate(row.deletedAt, dateFormat) : ""),
    },
    {
      key: "action",
      alwaysVisible: true,
      header: "",
      cell: (row) => (
        <RowActionButton
          deleted={row.deleted}
          noun="annotation"
          disabled={pending}
          onClick={() => handleDeleteToggle(row)}
        />
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
          placeholder="Search body or doc title…"
          label="Search annotations"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<AnnotationsFilters>)}
          onReset={() => navigate({ cols: null } as Partial<AnnotationsFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("annotations", cols);
            navigate({ cols: null } as Partial<AnnotationsFilters>);
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

      <table className={adminStyles.table}>
        <thead>
          <ColumnHeaderRow columns={visibleColumns} sort={filters.sort} onSort={handleSort} />
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <EmptyRow colSpan={visibleColumns.length} message="No annotations matching the criteria." />
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
      <CellError message={error} />

      <PaginationBar
        totalCount={totalCount}
        page={filters.page}
        pageSize={filters.pageSize}
        noun="annotations"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <DateFormatSelect value={dateFormat} onChange={setDateFormat} />
      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the annotation body, doc title, and author name/email."
        deepLinks={[
          deepLinkEntry("doc", "A doc id; shows only that doc's annotations."),
          deepLinkEntry("author", "A user id; shows only annotations on docs that user is credited as an author of."),
          deepLinkEntry("user", "A user id; shows only annotations written by that person."),
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            The <strong>Quote</strong> column is display-only: the annotated text is read out of the doc through its
            mark at render time (§12i), so there is no stored column to sort by. <strong>Status</strong> shows by
            default; <strong>Raised at</strong>, <strong>Resolved at</strong> and <strong>Deleted at</strong> are
            hidden by default (Columns picker, above).
          </p>
        }
      />
    </>
  );
}
