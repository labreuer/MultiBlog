"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { EmailCollisionSource } from "@/generated/prisma/enums";
import { bulkMarkEmailCollisionsReviewed, markEmailCollisionReviewed } from "@/app/actions/email-collisions";
import { formatDate } from "@/lib/format-date";
import { buildEmailCollisionsQueryString, type EmailCollisionsFilters } from "@/lib/email-collisions-query";
import { sameCols, type TablePrefs } from "@/lib/table-query";
import { useTableFilters } from "@/components/table/use-table-filters";
import { useRowStatus } from "@/components/table/use-row-status";
import { useRowSelection } from "@/components/table/use-row-selection";
import { BulkToolbar, SelectAllHeader, SelectRowCheckbox, type BulkAction } from "@/components/table/BulkToolbar";
import { FilterHelp } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { registryColumns, resolveColumns, type ColumnBody, type ColumnSpec } from "@/components/table/column-spec";
import type { AdminColumnKey } from "@/lib/admin-table-columns";
import { saveTableColumns } from "@/app/actions/table-preferences";
import { CellError, EmptyRow, PaginationBar, SearchBox, ShowDeletedToggle } from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";

// docs/COMMENTS.md, "The log" — /email-collisions, built from the shared
// table kit as every admin table is (CLAUDE.md, "Admin tables are one kit").
// One action, Mark reviewed, per row or in bulk; there is no undoing it
// (src/app/actions/email-collisions.ts says why).

export type EmailCollisionRow = {
  id: string;
  source: EmailCollisionSource;
  email: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** The account with the email; null once it is hard-deleted. */
  account: { name: string; email: string; deleted: boolean } | null;
  /** The anonymous identity with the email; null when there was none. */
  anonymous: { id: string; displayName: string } | null;
  anonymousComments: number;
  /** The requests' IP addresses, comma-separated. */
  requestIps: string;
  /** The anonymous identity's comments' IP addresses, read live. */
  anonymousIps: string;
  /** The account's own comments' IP addresses, read live. */
  accountIps: string;
  post: { id: string; title: string } | null;
  reviewedAt: Date | null;
  reviewedByName: string;
};

const SORTABLE_KEYS = [
  "lastSeen",
  "count",
  "source",
  "email",
  "account",
  "anonymous",
  "anonymousComments",
  "requestIps",
  "anonymousIps",
  "accountIps",
  "post",
  "firstSeen",
  "reviewedAt",
  "reviewedBy",
] as const;

const SOURCE_LABELS: Record<EmailCollisionSource, string> = {
  SIGNED_OUT_COMMENT: "Signed-out comment (refused)",
  SIGNED_IN_COMMENT: "Signed-in comment (kept apart)",
  EXISTING: "Found at deploy",
};

const dateTime = (date: Date) => formatDate(date, "yyyy-MM-dd HH:mm");

export default function EmailCollisionsTable({
  rows,
  totalCount,
  filters,
  prefs,
}: {
  rows: EmailCollisionRow[];
  totalCount: number;
  filters: EmailCollisionsFilters;
  prefs: TablePrefs;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort } = useTableFilters({
    filters,
    build: (next, extra) => buildEmailCollisionsQueryString(next, extra, prefs),
  });
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(rows);

  const bulkActions: BulkAction<EmailCollisionRow>[] = [
    {
      kind: "button",
      key: "review",
      label: "Mark selected reviewed",
      applicableTo: (row) => row.reviewedAt === null,
      run: bulkMarkEmailCollisionsReviewed,
    },
  ];

  function handleReview(row: EmailCollisionRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, () => markEmailCollisionReviewed(row.id));
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to mark the row reviewed.");
      }
    });
  }

  const columnBodies: Record<AdminColumnKey<"email-collisions">, ColumnBody<EmailCollisionRow>> = {
    lastSeen: { sortKey: "lastSeen", nowrap: true, cell: (row) => dateTime(row.lastSeenAt) },
    count: { sortKey: "count", cell: (row) => row.count },
    source: { sortKey: "source", cell: (row) => SOURCE_LABELS[row.source] },
    email: { sortKey: "email", cell: (row) => row.email },
    account: {
      sortKey: "account",
      // /users filtered to the account's email, deleted rows included, since
      // the account may have been deleted since.
      cell: (row) =>
        row.account ? (
          <>
            <Link href={`/users?q=${encodeURIComponent(row.account.email)}&deleted=1`}>{row.account.name}</Link>
            {row.account.name !== row.account.email && (
              <span style={{ color: "var(--text-secondary)" }}> ({row.account.email})</span>
            )}
            {row.account.deleted && <em> · deleted</em>}
          </>
        ) : (
          <em>none</em>
        ),
    },
    anonymous: {
      sortKey: "anonymous",
      // /comments filtered to this one identity by id: its `q` would match
      // the account's comments too, since they share the email.
      cell: (row) =>
        row.anonymous ? (
          <Link href={`/comments?commenter=${encodeURIComponent(row.anonymous.id)}&deleted=1`}>
            {row.anonymous.displayName}
          </Link>
        ) : (
          <em>none</em>
        ),
    },
    anonymousComments: { sortKey: "anonymousComments", cell: (row) => (row.anonymous ? row.anonymousComments : "") },
    requestIps: { sortKey: "requestIps", cell: (row) => row.requestIps },
    anonymousIps: { sortKey: "anonymousIps", cell: (row) => row.anonymousIps },
    accountIps: { sortKey: "accountIps", cell: (row) => row.accountIps },
    post: {
      sortKey: "post",
      cell: (row) => (row.post ? <Link href={`/post/${row.post.id}/comments`}>{row.post.title}</Link> : ""),
    },
    firstSeen: { sortKey: "firstSeen", nowrap: true, cell: (row) => dateTime(row.firstSeenAt) },
    reviewedAt: { sortKey: "reviewedAt", nowrap: true, cell: (row) => (row.reviewedAt ? dateTime(row.reviewedAt) : "") },
    reviewedBy: { sortKey: "reviewedBy", cell: (row) => row.reviewedByName },
  };
  const columns: ColumnSpec<EmailCollisionRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`collision on ${row.email}`}
        />
      ),
    },
    ...registryColumns("email-collisions", columnBodies),
    {
      key: "review",
      alwaysVisible: true,
      header: "Reviewed",
      cell: (row) =>
        row.reviewedAt ? (
          "✓"
        ) : (
          <button type="button" disabled={pending} onClick={() => handleReview(row)}>
            Mark reviewed
          </button>
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
          placeholder="Search emails, names or IP addresses…"
          label="Search email collisions"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<EmailCollisionsFilters>)}
          onReset={() => navigate({ cols: null } as Partial<EmailCollisionsFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("email-collisions", cols);
            navigate({ cols: null } as Partial<EmailCollisionsFilters>);
          }}
          isDefault={sameCols(filters.cols, prefs.cols)}
        />
      </div>

      <BulkToolbar
        selectedRows={selectedRows}
        actions={bulkActions}
        runWithStatus={runWithStatusMany}
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
            {rows.length === 0 && (
              <EmptyRow
                colSpan={visibleColumns.length}
                message={filters.reviewed ? "No email collisions." : "No email collisions waiting for review."}
              />
            )}
            {rows.map((row) => (
              <tr key={row.id} className={adminStyles.row}>
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
        noun="collisions"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle
        checked={filters.reviewed}
        onChange={(reviewed) => updateFilters({ reviewed } as Partial<EmailCollisionsFilters>)}
        label="Show reviewed rows"
      />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the email given, the account's name and email, the anonymous identity's name and email, and the last request's IP address; an exact IP address also matches any request's."
        filters={[
          {
            param: "reviewed",
            meaning: <>1 lists reviewed rows as well as those waiting.</>,
            control: "Show reviewed rows",
          },
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            A row is a place where an account and an anonymous commenter met on one email (docs/COMMENTS.md,
            &ldquo;The log&rdquo;). <strong>Signed-out comment</strong>: a comment typed with an account&apos;s
            email while signed out, which was refused. <strong>Signed-in comment</strong>: an account&apos;s first
            comment, while an anonymous identity held its email; the two were kept apart.{" "}
            <strong>Found at deploy</strong>: such a pair from before the fix. Repeats of one source and email fold
            into one row while it waits, whatever the IP address, so <strong>Times</strong> counts them and{" "}
            <strong>Request IPs</strong> keeps up to 20 of their addresses. The two comment IP columns are read live
            from the comments themselves. Marking a row reviewed can&apos;t be undone; the next meeting on the same
            email starts a new row. Merging two identities is done by hand.
          </p>
        }
      />
    </>
  );
}
