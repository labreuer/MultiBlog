"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { type DateFormat, formatDate } from "@/lib/format-date";
import {
  STATUS_OPTIONS,
  THREAD_STATUS_OPTIONS,
  type CommentsFilters,
  buildCommentsQueryString,
} from "@/lib/comments-query";
import type { PageSize } from "@/lib/table-query";
import {
  moderateComment,
  deleteComment,
  restoreComment,
  bulkModerateComments,
  bulkDeleteComments,
  bulkRestoreComments,
} from "@/app/actions/comments";
import type { CommentStatus, ThreadStatus } from "@/generated/prisma/enums";
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
import { FilterHelp, deepLinkEntry } from "@/components/table/FilterHelp";
import {
  CellError,
  DateFormatSelect,
  DeletedSortHeader,
  EmptyRow,
  MultiSelectDropdown,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
  SortHeader,
} from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";
import styles from "./CommentsTable.module.css";

export type CommentRow = {
  id: string;
  postId: string;
  postSlug: string;
  postTitle: string;
  commenterId: string;
  commenterName: string;
  commenterEmail: string;
  bodyText: string;
  status: CommentStatus;
  threadStatus: ThreadStatus;
  createdAt: Date;
  statusChangedAt: Date | null;
  deleted: boolean;
  commenterCounts: { submitted: number; inModeration: number; spam: number };
};

// Matches each status's text color to its moderation button's *hover* color
// (CommentsTable.module.css's .approve/.pend/.spam :hover rules), not its
// resting color — the resting fills are too pale to read well as text.
function statusTextClass(status: CommentStatus): string {
  switch (status) {
    case "APPROVED":
      return styles.statusApproved;
    case "PENDING":
      return styles.statusPending;
    case "SPAM":
      return styles.statusSpam;
    default:
      // CommentStatus.DELETED exists in the schema but is unused in
      // practice — soft-deletion is tracked via deletedByUserId, not this
      // enum (see STATUS_OPTIONS, which omits it). No corresponding
      // moderation button/hover color to match.
      return "";
  }
}

function ActionCell({
  comment,
  disabled,
  run,
}: {
  comment: CommentRow;
  disabled: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = (action: "approve" | "pend" | "spam") => {
    setError(null);
    startTransition(async () => {
      try {
        await run(async () => {
          await moderateComment(comment.id, action);
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to moderate comment.");
      }
    });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          onClick={() => handle("approve")}
          disabled={disabled || pending || comment.status === "APPROVED"}
          className={`${adminStyles.actionButton} ${styles.approve}`}
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => handle("pend")}
          disabled={disabled || pending || comment.status === "PENDING"}
          className={`${adminStyles.actionButton} ${styles.pend}`}
        >
          Pend
        </button>
        <button
          type="button"
          onClick={() => handle("spam")}
          disabled={disabled || pending || comment.status === "SPAM"}
          className={`${adminStyles.actionButton} ${styles.spam}`}
        >
          Spam
        </button>
      </div>
      <CellError message={error} />
    </>
  );
}

const SORTABLE_KEYS = ["post", "commenter", "status", "threadStatus", "created", "statusChanged", "deleted"] as const;
const COLUMN_COUNT = 11;

export default function CommentsTable({
  rows,
  totalCount,
  filters,
  defaultPageSize,
}: {
  rows: CommentRow[];
  totalCount: number;
  filters: CommentsFilters;
  defaultPageSize: PageSize;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [rowPending, startRowTransition] = useTransition();
  const [rowError, setRowError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildCommentsQueryString(next, extra, defaultPageSize),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  // Approve/Pend/Spam mirror the per-row Action column, and skip a row that's
  // already in the target status or soft-deleted rather than erroring.
  const bulkActions: BulkAction<CommentRow>[] = [
    ...(["approve", "pend", "spam"] as const).map((action) => ({
      kind: "button" as const,
      key: action,
      label: action === "approve" ? "Approve" : action === "pend" ? "Pend" : "Spam",
      className: action === "approve" ? styles.approve : action === "pend" ? styles.pend : styles.spam,
      applicableTo: (row: CommentRow) => !row.deleted,
      run: (ids: string[]) => bulkModerateComments(ids, action),
    })),
    ...softDeleteBulkActions<CommentRow>("comments", bulkDeleteComments, bulkRestoreComments),
  ];

  function handleDeleteToggle(row: CommentRow) {
    setRowError(null);
    startRowTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreComment(row.id);
          } else {
            await deleteComment(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setRowError(e instanceof Error ? e.message : "Failed to update comment.");
      }
    });
  }

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search comment or commenter …"
          label="Search comments"
        />
        <MultiSelectDropdown
          label="Status"
          options={STATUS_OPTIONS}
          selected={filters.status}
          onChange={(next) => updateFilters({ status: next })}
        />
        <MultiSelectDropdown
          label="Thread status"
          options={THREAD_STATUS_OPTIONS}
          selected={filters.threadStatus}
          onChange={(next) => updateFilters({ threadStatus: next })}
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
            <SortHeader sortKey="post" sort={filters.sort} onSort={handleSort} className={styles.postColumn}>
              Post
            </SortHeader>
            <SortHeader sortKey="commenter" sort={filters.sort} onSort={handleSort}>
              Commenter
            </SortHeader>
            <th className={adminStyles.headerCell}>Comment</th>
            <SortHeader sortKey="status" sort={filters.sort} onSort={handleSort}>
              Status
            </SortHeader>
            <SortHeader sortKey="threadStatus" sort={filters.sort} onSort={handleSort}>
              Thread
            </SortHeader>
            <SortHeader sortKey="created" sort={filters.sort} onSort={handleSort} nowrap>
              Created at
            </SortHeader>
            <SortHeader
              sortKey="statusChanged"
              sort={filters.sort}
              onSort={handleSort}
              nowrap
              title="Last moderation change"
            >
              Changed at
            </SortHeader>
            <th className={adminStyles.headerCell}>Commenter activity</th>
            <th className={adminStyles.headerCell}>Action</th>
            <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <EmptyRow colSpan={COLUMN_COUNT} message="(no comments matching the criteria)" />
          )}
          {displayRows.map((row) => (
            <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
              <td className={`${adminStyles.cell} ${rowStatusClass(row.id)}`} title={rowStatusTitle(row.id)}>
                <SelectRowCheckbox
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleRow(row.id)}
                  label={`comment from ${row.commenterName}`}
                />
              </td>
              <td className={adminStyles.cell}>
                <Link href={`/posts/${row.postId}/comments`}>{row.postTitle}</Link>
              </td>
              <td className={adminStyles.cell}>
                {row.commenterName} <span style={{ color: "#666" }}>({row.commenterEmail})</span>
              </td>
              <td className={adminStyles.cell} style={{ maxWidth: 320 }}>
                {row.bodyText}
              </td>
              <td className={`${adminStyles.cell} ${statusTextClass(row.status)}`}>{row.status}</td>
              <td className={adminStyles.cell}>{row.threadStatus}</td>
              <td className={adminStyles.nowrapCell}>{formatDate(row.createdAt, dateFormat)}</td>
              <td className={adminStyles.nowrapCell}>
                {row.statusChangedAt ? formatDate(row.statusChangedAt, dateFormat) : ""}
              </td>
              <td className={adminStyles.nowrapCell}>
                {row.commenterCounts.submitted} / {row.commenterCounts.inModeration} / {row.commenterCounts.spam}
              </td>
              <td className={adminStyles.cell}>
                <ActionCell
                  comment={row}
                  disabled={row.deleted}
                  run={(action) => runWithStatus(row.id, action)}
                />
              </td>
              <td className={adminStyles.cell}>
                <RowActionButton
                  deleted={row.deleted}
                  noun="comment"
                  disabled={rowPending}
                  onClick={() => handleDeleteToggle(row)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CellError message={rowError} />

      <PaginationBar
        totalCount={totalCount}
        page={filters.page}
        pageSize={filters.pageSize}
        noun="comments"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <DateFormatSelect value={dateFormat} onChange={setDateFormat} />
      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={defaultPageSize}
        searchDescription="Free-text search over the comment body and commenter name/email."
        filters={[
          {
            param: "status",
            meaning: <>Comma-separated {STATUS_OPTIONS.join(", ")}; omitted means all.</>,
            control: "Status dropdown",
          },
          {
            param: "threadStatus",
            meaning: <>Comma-separated {THREAD_STATUS_OPTIONS.join(", ")}; omitted means all.</>,
            control: "Thread status dropdown",
          },
        ]}
        deepLinks={[
          deepLinkEntry("post", "A post id; shows only that post's comments."),
          deepLinkEntry("author", "A user id; shows only comments on posts that user is credited as an author of."),
          deepLinkEntry("commenter", "A commenter id; shows only that person's comments."),
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            The <strong>Commenter activity</strong> column reads {"{submitted} / {in moderation} / {spam}"} — counts of
            that commenter&apos;s non-deleted comments visible on this page (an author only sees counts scoped to their
            own posts), independent of the current status/thread-status/search filters. Display-only: sorting by it
            would need a correlated subquery per row rather than a plain <code>ORDER BY</code>.
          </p>
        }
      />
    </>
  );
}
