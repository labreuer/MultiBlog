"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deleteDoc, restoreDoc, bulkDeleteDocs, bulkRestoreDocs, bulkSetDocVisibility } from "@/app/actions/docs";
import { formatDate } from "@/lib/format-date";
import { DocVisibility } from "@/generated/prisma/enums";
import { type DocsFilters, buildDocsQueryString } from "@/lib/docs-query";
import type { PageSize } from "@/lib/table-query";
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
import {
  CellError,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
  SortHeader,
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
  // Character count from doc_length(prose_json) (see /docs/page.tsx) — a
  // Postgres function, not something computed here, so a doc's full body
  // never has to reach this component to show its length. Display-only:
  // there's no column for an `orderBy` to name (PLAN.md §16e).
  length: number;
  deleted: boolean;
  canEdit: boolean;
};

const SORTABLE_KEYS = ["title", "visibility", "created", "deleted"] as const;
const COLUMN_COUNT = 8;

export default function DocsTable({
  rows,
  totalCount,
  filters,
  defaultPageSize,
}: {
  rows: DocRow[];
  totalCount: number;
  filters: DocsFilters;
  defaultPageSize: PageSize;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildDocsQueryString(next, extra, defaultPageSize),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, runWithStatus } = useRowStatus();
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
      </div>

      <BulkToolbar
        selectedRows={selectedRows}
        actions={bulkActions}
        onDeleted={revealRows}
        onDone={() => {
          clearSelection();
          router.refresh();
        }}
      />

      <table className={adminStyles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />
            <SortHeader sortKey="title" sort={filters.sort} onSort={handleSort}>
              Title
            </SortHeader>
            <th className={adminStyles.headerCell}>Edit</th>
            <th className={adminStyles.headerCell}>Author(s)</th>
            <SortHeader sortKey="visibility" sort={filters.sort} onSort={handleSort}>
              Visibility
            </SortHeader>
            <SortHeader sortKey="created" sort={filters.sort} onSort={handleSort} nowrap>
              Created
            </SortHeader>
            <th className={adminStyles.nowrapHeaderCell}>Length</th>
            <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && <EmptyRow colSpan={COLUMN_COUNT} message="No docs matching the criteria." />}
          {displayRows.map((row) => (
            <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
              <td className={`${adminStyles.cell} ${rowStatusClass(row.id)}`}>
                <SelectRowCheckbox
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleRow(row.id)}
                  label={`doc ${row.title}`}
                />
              </td>
              <td
                className={`${adminStyles.cell} ${styles.titleCell}`}
                onClick={(e) => {
                  if (!(e.target instanceof Element) || !e.target.closest("a")) {
                    router.push(`/doc/${row.id}`);
                  }
                }}
              >
                <Link href={`/doc/${row.id}`}>{row.title}</Link>
              </td>
              <td className={adminStyles.cell}>{row.canEdit && <Link href={`/doc/${row.id}/edit`}>edit</Link>}</td>
              <td className={adminStyles.cell}>{row.authors}</td>
              <td className={adminStyles.cell}>{row.visibility}</td>
              <td className={adminStyles.nowrapCell}>{formatDate(row.createdAt, "yyyy-MM-dd HH:mm")}</td>
              <td className={adminStyles.nowrapCell}>{row.length.toLocaleString()}</td>
              <td className={adminStyles.cell}>
                <RowActionButton
                  deleted={row.deleted}
                  noun="doc"
                  disabled={pending}
                  onClick={() => handleDeleteToggle(row)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={defaultPageSize}
        searchDescription="Free-text search over the doc title."
        notes={
          <p style={{ marginTop: 8 }}>
            <strong>Author(s)</strong> and <strong>Length</strong> are display-only: the first is a joined list across
            a doc&apos;s authors, the second is computed in Postgres from the document body, and neither is a column an
            <code> ORDER BY</code> can name (PLAN.md §16e).
          </p>
        }
      />
    </>
  );
}
