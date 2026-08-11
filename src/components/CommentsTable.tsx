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
import { sameCols, type TablePrefs } from "@/lib/table-query";
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
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { resolveColumns, type ColumnSpec } from "@/components/table/column-spec";
import { saveTableColumns } from "@/app/actions/table-preferences";
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
  ipAddress: string | null;
  // "" when nobody has ever moderated the comment — resolved server-side from
  // statusChangedBy's name-or-email, same fallback annotations use for author.
  statusChangedByName: string;
  editedAt: Date | null;
  deletedAt: Date | null;
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

const SORTABLE_KEYS = [
  "post",
  "commenter",
  "status",
  "threadStatus",
  "created",
  "statusChanged",
  "ipAddress",
  "statusChangedBy",
  "editedAt",
  "deletedAt",
  "deleted",
] as const;

export default function CommentsTable({
  rows,
  totalCount,
  filters,
  prefs,
}: {
  rows: CommentRow[];
  totalCount: number;
  filters: CommentsFilters;
  prefs: TablePrefs;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [rowPending, startRowTransition] = useTransition();
  const [rowError, setRowError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildCommentsQueryString(next, extra, prefs),
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

  // Declared in the order they render by default; `?cols=` reorders and hides
  // the movable ones from here (§16i).
  const columns: ColumnSpec<CommentRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`comment from ${row.commenterName}`}
        />
      ),
    },
    {
      key: "post",
      header: "Post",
      sortKey: "post",
      headerClassName: styles.postColumn,
      cell: (row) => <Link href={`/posts/${row.postId}/comments`}>{row.postTitle}</Link>,
    },
    {
      key: "commenter",
      header: "Commenter",
      sortKey: "commenter",
      cell: (row) => (
        <>
          {row.commenterName} <span style={{ color: "var(--text-secondary)" }}>({row.commenterEmail})</span>
        </>
      ),
    },
    {
      key: "comment",
      header: "Comment",
      cellProps: () => ({ className: styles.commentColumn }),
      cell: (row) => row.bodyText,
    },
    {
      key: "status",
      header: "Status",
      sortKey: "status",
      cellProps: (row) => ({ className: statusTextClass(row.status) }),
      cell: (row) => row.status,
    },
    { key: "threadStatus", header: "Thread", sortKey: "threadStatus", cell: (row) => row.threadStatus },
    {
      key: "created",
      header: "Created at",
      sortKey: "created",
      nowrap: true,
      cell: (row) => formatDate(row.createdAt, dateFormat),
    },
    {
      key: "statusChanged",
      header: "Changed at",
      sortKey: "statusChanged",
      nowrap: true,
      headerTitle: "Last moderation change",
      cell: (row) => (row.statusChangedAt ? formatDate(row.statusChangedAt, dateFormat) : ""),
    },
    {
      key: "commenterActivity",
      header: "Commenter activity",
      nowrap: true,
      cell: (row) => (
        <>
          {row.commenterCounts.submitted} / {row.commenterCounts.inModeration} / {row.commenterCounts.spam}
        </>
      ),
    },
    {
      key: "action",
      header: "Action",
      cell: (row) => <ActionCell comment={row} disabled={row.deleted} run={(action) => runWithStatus(row.id, action)} />,
    },
    // Defaulted hidden (§16l/§16i): real Comment columns, available on
    // request. statusChangedBy is resolved server-side to a name/email
    // rather than shown as a raw id, matching how every other identity in
    // this table is already displayed.
    {
      key: "ipAddress",
      header: "IP address",
      sortKey: "ipAddress",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => row.ipAddress ?? "",
    },
    {
      key: "statusChangedBy",
      header: "Changed by",
      sortKey: "statusChangedBy",
      defaultHidden: true,
      cell: (row) => row.statusChangedByName,
    },
    {
      key: "editedAt",
      header: "Edited at",
      sortKey: "editedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => (row.editedAt ? formatDate(row.editedAt, dateFormat) : ""),
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
        <RowActionButton
          deleted={row.deleted}
          noun="comment"
          disabled={rowPending}
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
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<CommentsFilters>)}
          onReset={() => navigate({ cols: null } as Partial<CommentsFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("comments", cols);
            navigate({ cols: null } as Partial<CommentsFilters>);
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
              <EmptyRow colSpan={visibleColumns.length} message="(no comments matching the criteria)" />
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
        defaultPageSize={prefs.pageSize}
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
            would need a correlated subquery per row rather than a plain <code>ORDER BY</code>.{" "}
            <strong>IP address</strong>, <strong>Changed by</strong>, <strong>Edited at</strong> and{" "}
            <strong>Deleted at</strong> are hidden by default (Columns picker, above).
          </p>
        }
      />
    </>
  );
}
