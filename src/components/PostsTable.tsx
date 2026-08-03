"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deletePost, restorePost, bulkDeletePosts, bulkRestorePosts } from "@/app/actions/posts";
import { type DateFormat, formatDate } from "@/lib/format-date";
import { type PostsFilters, buildPostsQueryString } from "@/lib/posts-query";
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
} from "@/components/table/BulkToolbar";
import { FilterHelp } from "@/components/table/FilterHelp";
import {
  CellError,
  DateFormatSelect,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
  SortHeader,
} from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";

export type PostRow = {
  id: string;
  slug: string;
  title: string;
  authors: string;
  status: "draft" | "scheduled" | "published";
  publishedAt: Date | null;
  createdAt: Date;
  eventCount: number;
  lastEditorName: string;
  lastEditAt: Date | null;
  approved: number;
  pending: number;
  deleted: boolean;
};

// Calendar-aware breakdown (not a flat 365.25-day-year approximation) of the
// time remaining until `target`, dropping leading zero-valued units — years/
// months/days only appear if non-zero, hours+minutes always appear together
// as the finest-grained element.
function formatCountdown(target: Date): string {
  const now = new Date();
  let cursor = now;
  let years = 0;
  let months = 0;
  let days = 0;

  const step = (advance: (d: Date) => Date) => {
    let count = 0;
    while (true) {
      const next = advance(cursor);
      if (next > target) break;
      cursor = next;
      count++;
    }
    return count;
  };

  years = step((d) => {
    const next = new Date(d);
    next.setFullYear(next.getFullYear() + 1);
    return next;
  });
  months = step((d) => {
    const next = new Date(d);
    next.setMonth(next.getMonth() + 1);
    return next;
  });
  days = step((d) => {
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    return next;
  });

  const remainingMs = Math.max(0, target.getTime() - cursor.getTime());
  const totalMinutes = Math.floor(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} years`);
  if (months > 0) parts.push(`${months} months`);
  if (days > 0) parts.push(`${days} d`);
  parts.push(`${hours}h${minutes}m`);

  return parts.join(" ");
}

const SORTABLE_KEYS = [
  "title",
  "authors",
  "published",
  "comments",
  "events",
  "editor",
  "lastEdit",
  "created",
  "deleted",
] as const;
const COLUMN_COUNT = 10;

export default function PostsTable({
  rows,
  totalCount,
  filters,
  defaultPageSize,
}: {
  rows: PostRow[];
  totalCount: number;
  filters: PostsFilters;
  defaultPageSize: PageSize;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [titleWidth, setTitleWidth] = useState<number | null>(null);
  const titleThRef = useRef<HTMLTableCellElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildPostsQueryString(next, extra, defaultPageSize),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  const bulkActions = softDeleteBulkActions<PostRow>("posts", bulkDeletePosts, bulkRestorePosts);

  useEffect(() => {
    const el = titleThRef.current;
    if (!el) return;
    // getBoundingClientRect (not ResizeObserver's contentRect, which excludes
    // padding) so this matches the Title column's actual rendered width.
    const update = () => setTitleWidth(el.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function handleDeleteToggle(row: PostRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restorePost(row.id);
          } else {
            await deletePost(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update post.");
      }
    });
  }

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search title …"
          label="Search title"
          width={titleWidth ?? undefined}
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
          <tr style={{ textAlign: "left" }}>
            <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />
            <SortHeader sortKey="title" sort={filters.sort} onSort={handleSort} thRef={titleThRef}>
              Title
            </SortHeader>
            <SortHeader sortKey="authors" sort={filters.sort} onSort={handleSort}>
              Author(s)
            </SortHeader>
            <SortHeader sortKey="published" sort={filters.sort} onSort={handleSort}>
              Published
            </SortHeader>
            <SortHeader sortKey="comments" sort={filters.sort} onSort={handleSort}>
              Comments
            </SortHeader>
            <SortHeader sortKey="events" sort={filters.sort} onSort={handleSort}>
              History
            </SortHeader>
            <SortHeader sortKey="editor" sort={filters.sort} onSort={handleSort} nowrap>
              Last edit by
            </SortHeader>
            <SortHeader sortKey="lastEdit" sort={filters.sort} onSort={handleSort} nowrap>
              Last edit at
            </SortHeader>
            <SortHeader sortKey="created" sort={filters.sort} onSort={handleSort} nowrap>
              Created at
            </SortHeader>
            <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && <EmptyRow colSpan={COLUMN_COUNT} message="No posts matching the criteria." />}
          {displayRows.map((row) => (
            <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
              <td className={`${adminStyles.cell} ${rowStatusClass(row.id)}`} title={rowStatusTitle(row.id)}>
                <SelectRowCheckbox
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleRow(row.id)}
                  label={`post ${row.title}`}
                />
              </td>
              <td className={adminStyles.cell}>
                <Link href={`/posts/${row.id}/edit`}>{row.title}</Link>
              </td>
              <td className={adminStyles.cell}>{row.authors}</td>
              <td className={adminStyles.nowrapCell}>
                {row.status === "published" && row.publishedAt ? (
                  <Link href={`/${row.slug}`}>{formatDate(row.publishedAt, dateFormat)}</Link>
                ) : row.status === "scheduled" && row.publishedAt ? (
                  <span style={{ color: "#666" }} title={`Scheduled: ${formatCountdown(row.publishedAt)}`}>
                    {formatDate(row.publishedAt, dateFormat)}
                  </span>
                ) : (
                  ""
                )}
              </td>
              <td className={adminStyles.cell}>
                {row.approved}
                {row.pending > 0 && (
                  <>
                    {" "}
                    <Link href={`/posts/${row.id}/comments`}>(in moderation {row.pending})</Link>
                  </>
                )}
              </td>
              <td className={adminStyles.cell}>
                <Link href={`/posts/${row.id}/history`}>{row.eventCount === 0 ? "none" : row.eventCount}</Link>
              </td>
              <td className={adminStyles.nowrapCell}>{row.lastEditorName}</td>
              <td className={adminStyles.nowrapCell}>{row.lastEditAt ? formatDate(row.lastEditAt, dateFormat) : ""}</td>
              <td className={adminStyles.nowrapCell}>{formatDate(row.createdAt, dateFormat)}</td>
              <td className={adminStyles.cell}>
                <RowActionButton
                  deleted={row.deleted}
                  noun="post"
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
        noun="posts"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <DateFormatSelect value={dateFormat} onChange={setDateFormat} />
      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={defaultPageSize}
        searchDescription="Free-text search over the post title."
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts. Four do so through a database view, because each is derived from a to-many
            relation that a plain <code>ORDER BY</code> cannot reach: <strong>Last edit by/at</strong> resolve each
            post&apos;s most recent publication event via <code>post_activity</code>, while{" "}
            <strong>Author(s)</strong> and <strong>Comments</strong> come from <code>post_metrics</code> — the byline
            joined in SQL, and approved/pending counts that exclude deleted comments. Sorting by{" "}
            <strong>Comments</strong> orders by the approved count, using the moderation count only to break ties
            (PLAN.md §16e).
          </p>
        }
      />
    </>
  );
}
