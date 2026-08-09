"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deletePost, restorePost, bulkDeletePosts, bulkRestorePosts } from "@/app/actions/posts";
import type { ModerationPolicy } from "@/generated/prisma/enums";
import { type DateFormat, formatDate } from "@/lib/format-date";
import { type PostsFilters, buildPostsQueryString } from "@/lib/posts-query";
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
} from "@/components/table/BulkToolbar";
import { FilterHelp } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { resolveColumns, type ColumnSpec } from "@/components/table/column-spec";
import { saveTableColumns } from "@/app/actions/table-preferences";
import {
  CellError,
  DateFormatSelect,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
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
  moderationPolicy: ModerationPolicy;
  deletedAt: Date | null;
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
  "slug",
  "moderationPolicy",
  "deletedAt",
  "deleted",
] as const;

export default function PostsTable({
  rows,
  totalCount,
  filters,
  prefs,
}: {
  rows: PostRow[];
  totalCount: number;
  filters: PostsFilters;
  prefs: TablePrefs;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [titleWidth, setTitleWidth] = useState<number | null>(null);
  const titleThRef = useRef<HTMLTableCellElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildPostsQueryString(next, extra, prefs),
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

  // Declared in the order they render by default; `?cols=` reorders and hides
  // the movable ones from here (§16i). Built in the component body rather than
  // at module scope so a cell stays an ordinary React expression closing over
  // dateFormat, the selection and the pending state.
  const columns: ColumnSpec<PostRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`post ${row.title}`}
        />
      ),
    },
    {
      key: "title",
      header: "Title",
      sortKey: "title",
      thRef: titleThRef,
      cell: (row) => <Link href={`/posts/${row.id}/edit`}>{row.title}</Link>,
    },
    { key: "authors", header: "Author(s)", sortKey: "authors", cell: (row) => row.authors },
    {
      key: "published",
      header: "Published",
      sortKey: "published",
      nowrap: true,
      cell: (row) =>
        row.status === "published" && row.publishedAt ? (
          <Link href={`/${row.slug}`}>{formatDate(row.publishedAt, dateFormat)}</Link>
        ) : row.status === "scheduled" && row.publishedAt ? (
          <span style={{ color: "var(--text-secondary)" }} title={`Scheduled: ${formatCountdown(row.publishedAt)}`}>
            {formatDate(row.publishedAt, dateFormat)}
          </span>
        ) : (
          ""
        ),
    },
    {
      key: "comments",
      header: "Comments",
      sortKey: "comments",
      cell: (row) => (
        <>
          {row.approved}
          {row.pending > 0 && (
            <>
              {" "}
              <Link href={`/posts/${row.id}/comments`}>(in moderation {row.pending})</Link>
            </>
          )}
        </>
      ),
    },
    {
      key: "events",
      header: "History",
      sortKey: "events",
      cell: (row) => <Link href={`/posts/${row.id}/history`}>{row.eventCount === 0 ? "none" : row.eventCount}</Link>,
    },
    { key: "editor", header: "Last edit by", sortKey: "editor", nowrap: true, cell: (row) => row.lastEditorName },
    {
      key: "lastEdit",
      header: "Last edit at",
      sortKey: "lastEdit",
      nowrap: true,
      cell: (row) => (row.lastEditAt ? formatDate(row.lastEditAt, dateFormat) : ""),
    },
    {
      key: "created",
      header: "Created at",
      sortKey: "created",
      nowrap: true,
      cell: (row) => formatDate(row.createdAt, dateFormat),
    },
    // Defaulted hidden (§16l/§16i): real Post columns, available on request
    // rather than cluttering the default view. slug is otherwise unused here
    // (the Published link uses row.id); moderationPolicy is the raw column,
    // distinct from the resolved policy other columns already imply;
    // deletedAt is the timestamp behind the existing Deleted action column's
    // boolean.
    { key: "slug", header: "Slug", sortKey: "slug", defaultHidden: true, cell: (row) => row.slug },
    {
      key: "moderationPolicy",
      header: "Moderation policy",
      sortKey: "moderationPolicy",
      defaultHidden: true,
      cell: (row) => row.moderationPolicy,
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
      key: "deleted",
      alwaysVisible: true,
      header: "Deleted",
      renderHeader: () => <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />,
      cell: (row) => (
        <RowActionButton deleted={row.deleted} noun="post" disabled={pending} onClick={() => handleDeleteToggle(row)} />
      ),
    },
  ];
  // resolveColumns only filters/reorders `columns` by `key`; it never dereferences `.current`.
  // The lint is conservative about *any* function receiving a value that structurally contains a
  // ref (here, the Title column's `thRef`), since it can't see inside a generic helper to confirm
  // that. The ref itself only ever reaches a real `ref={...}` prop, via ColumnHeaderRow -> SortHeader.
  // eslint-disable-next-line react-hooks/refs
  const visibleColumns = resolveColumns(columns, filters.cols);

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
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<PostsFilters>)}
          onReset={() => navigate({ cols: null } as Partial<PostsFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("posts", cols);
            navigate({ cols: null } as Partial<PostsFilters>);
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
            <EmptyRow colSpan={visibleColumns.length} message="No posts matching the criteria." />
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
        noun="posts"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <DateFormatSelect value={dateFormat} onChange={setDateFormat} />
      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the post title."
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts. Four do so through a database view, because each is derived from a to-many
            relation that a plain <code>ORDER BY</code> cannot reach: <strong>Last edit by/at</strong> resolve each
            post&apos;s most recent publication event via <code>post_activity</code>, while{" "}
            <strong>Author(s)</strong> and <strong>Comments</strong> come from <code>post_metrics</code> — the byline
            joined in SQL, and approved/pending counts that exclude deleted comments. Sorting by{" "}
            <strong>Comments</strong> orders by the approved count, using the moderation count only to break ties
            (PLAN.md §16e). <strong>Slug</strong>, <strong>Moderation policy</strong> and <strong>Deleted at</strong>{" "}
            are hidden by default (Columns picker, above) but sort like any other column.
          </p>
        }
      />
    </>
  );
}
