"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { type DateFormat, formatDate } from "@/lib/format-date";
import { type AnnotationsFilters, buildAnnotationsQueryString } from "@/lib/annotations-query";
import type { PageSize } from "@/lib/table-query";
import { deleteAnnotation, restoreAnnotation } from "@/app/actions/annotations";
import { useTableFilters } from "@/components/table/use-table-filters";
import { useRevealedRows } from "@/components/table/use-revealed-rows";
import { useRowStatus } from "@/components/table/use-row-status";
import { FilterHelp, deepLinkEntry } from "@/components/table/FilterHelp";
import {
  CellError,
  DateFormatSelect,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
  SortHeader,
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
  deleted: boolean;
};

const SORTABLE_KEYS = ["doc", "author", "created", "edited", "deleted"] as const;
const COLUMN_COUNT = 8;

// A much smaller sibling of CommentsTable (PLAN.md §12j): no status/thread-
// status filters, no moderation buttons — the only action an annotation
// supports is Delete/Restore, already a per-row icon button.
export default function AnnotationsTable({
  rows,
  totalCount,
  filters,
  defaultPageSize,
}: {
  rows: AnnotationRow[];
  totalCount: number;
  filters: AnnotationsFilters;
  defaultPageSize: PageSize;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd HH:mm");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildAnnotationsQueryString(next, extra, defaultPageSize),
  });
  const { displayRows, revealRow } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, runWithStatus } = useRowStatus();

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

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search body or doc title…"
          label="Search annotations"
        />
      </div>

      <table className={adminStyles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <SortHeader sortKey="doc" sort={filters.sort} onSort={handleSort}>
              Doc
            </SortHeader>
            <SortHeader sortKey="author" sort={filters.sort} onSort={handleSort}>
              Author
            </SortHeader>
            <th className={adminStyles.headerCell}>Body</th>
            <th className={adminStyles.headerCell}>Quote</th>
            <SortHeader sortKey="created" sort={filters.sort} onSort={handleSort} nowrap>
              Created
            </SortHeader>
            <SortHeader sortKey="edited" sort={filters.sort} onSort={handleSort} nowrap>
              Edited
            </SortHeader>
            <SortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort}>
              Deleted
            </SortHeader>
            <th className={adminStyles.headerCell}></th>
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <EmptyRow colSpan={COLUMN_COUNT} message="No annotations matching the criteria." />
          )}
          {displayRows.map((row) => (
            <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
              <td className={`${adminStyles.cell} ${rowStatusClass(row.id)}`}>
                <Link href={`/doc/${row.docSlug}`}>{row.docTitle}</Link>
              </td>
              <td className={adminStyles.cell}>{row.authorName}</td>
              <td className={adminStyles.cell}>{row.bodyText}</td>
              <td className={adminStyles.cell}>
                {!row.isRoot ? "" : row.quote ? `“${row.quote}”` : <em>document-level</em>}
              </td>
              <td className={adminStyles.nowrapCell}>{formatDate(row.createdAt, dateFormat)}</td>
              <td className={adminStyles.nowrapCell}>{row.editedAt ? formatDate(row.editedAt, dateFormat) : ""}</td>
              <td className={adminStyles.cell}>{row.deleted ? "Yes" : ""}</td>
              <td className={adminStyles.cell}>
                <RowActionButton
                  deleted={row.deleted}
                  noun="annotation"
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
        noun="annotations"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <DateFormatSelect value={dateFormat} onChange={setDateFormat} />
      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={defaultPageSize}
        searchDescription="Free-text search over the annotation body, doc title, and author name/email."
        deepLinks={[
          deepLinkEntry("doc", "A doc id; shows only that doc's annotations."),
          deepLinkEntry("author", "A user id; shows only annotations on docs that user is credited as an author of."),
          deepLinkEntry("user", "A user id; shows only annotations written by that person."),
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            The <strong>Quote</strong> column is display-only: the annotated text is read out of the doc through its
            mark at render time (§12i), so there is no stored column to sort by.
          </p>
        }
      />
    </>
  );
}
