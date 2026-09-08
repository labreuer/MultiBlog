"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  bulkDeleteAnchoredLinks,
  bulkRestoreAnchoredLinks,
  deleteAnchoredLink,
  restoreAnchoredLink,
} from "@/app/actions/anchored-links";
import { formatDate } from "@/lib/format-date";
import { type LinksFilters, buildLinksQueryString } from "@/lib/links-query";
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
import { FilterHelp, deepLinkEntry } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
// Aliased as FilesTable aliases it: the kit's panel takes its wording from
// props, and the only thing that reads in this table's vocabulary is the name
// it is used under here.
import { AuthorFilterPanel as OwnerFilterPanel, type AuthorOption } from "@/components/table/AuthorFilterPanel";
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
import styles from "./LinksTable.module.css";

// docs/ANCHORED_LINKS.md, "The management table" — /links, built from the
// shared table kit exactly as /tags and /files are. A new admin table means a
// `*-query.ts` and the kit's hooks, never a fresh `<table>` (CLAUDE.md).
//
// What this table shows of a link is **what the viewer could follow**: the
// page has already run the follow path's per-target read filter over every
// row's anchors, so `targets` holds only the groups this viewer may read and
// an unreadable one is simply absent — no count, no placeholder — exactly as
// the banner and the landing page omit it. That is also why Passages and
// Targets carry no sortKey (src/lib/links-query.ts).
//
// The one action is Delete/Restore, a soft delete: a deleted link 404s for
// everyone who follows it until restored. Who may do it is decided per row on
// the server (`canManage`, the /files shape) — its creator or ADMIN/EDITOR,
// and never a draft, which is discarded from its tray instead.

export type LinkRowTarget = {
  kind: "doc" | "file";
  title: string;
  /** Carries `?sel=` already, the way the banner's group links do. */
  href: string;
  /** This target's parts' stored quotes, in part order. */
  quotes: string[];
};

export type LinkRow = {
  id: string;
  createdByName: string;
  createdAt: Date;
  /** Null for the viewer's own open draft — the only draft this table ever lists. */
  mintedAt: Date | null;
  /** Readable target groups in first-part order; empty when the viewer may read none. */
  targets: LinkRowTarget[];
  deletedAt: Date | null;
  deleted: boolean;
  canManage: boolean;
};

const SORTABLE_KEYS = ["createdBy", "created", "minted", "id", "deletedAt", "deleted"] as const;

// The tray shows ~60 characters of a part; a table cell has a little more
// room but not a paragraph's worth.
const QUOTE_SNIPPET_LENGTH = 90;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_SNIPPET_LENGTH ? `${flat.slice(0, QUOTE_SNIPPET_LENGTH - 1)}…` : flat;
}

export default function LinksTable({
  rows,
  totalCount,
  filters,
  prefs,
  ownerOptions,
}: {
  rows: LinkRow[];
  totalCount: number;
  filters: LinksFilters;
  prefs: TablePrefs;
  /** Everyone who created a link this viewer may list — not every eligible user, as /files has (page.tsx). */
  ownerOptions: AuthorOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildLinksQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  // Delete/restore only, and only for rows this viewer may act on — the
  // /files shape, since `canManage` varies by row here too (own link vs.
  // someone else's, minted vs. draft).
  const bulkActions: BulkAction<LinkRow>[] = softDeleteBulkActions<LinkRow>(
    "links",
    bulkDeleteAnchoredLinks,
    bulkRestoreAnchoredLinks,
  ).map((action) => ({
    ...action,
    applicableTo: (row: LinkRow) => row.canManage && action.applicableTo(row),
  }));

  const columns: ColumnSpec<LinkRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`link by ${row.createdByName}`}
        />
      ),
    },
    {
      key: "passages",
      header: "Passages",
      // The count links to the landing route with ?noredirect=1 — the excerpt
      // page, never the redirect: someone browsing this table wants to see the
      // whole link, not be dropped into one of its docs.
      cell: (row) => {
        const quotes = row.targets.flatMap((target) => target.quotes);
        return (
          <div>
            <Link href={`/link/${row.id}?noredirect=1`}>
              {quotes.length} {quotes.length === 1 ? "passage" : "passages"}
            </Link>
            {quotes.map((quote, i) => (
              <div key={i} className={styles.quote}>
                “{snippet(quote)}”
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "targets",
      header: "Targets",
      // Each title carries ?sel= into its own surface, like the banner's group
      // links. An empty list is the landing page's "no passages you have
      // permission to read", said shorter — it acknowledges the link, which
      // the viewer can already see exists, and nothing about what it points at.
      cell: (row) =>
        row.targets.length === 0 ? (
          <em>none readable</em>
        ) : (
          <div>
            {row.targets.map((target) => (
              <div key={target.href} className={styles.targetRow}>
                <span className={styles.kind}>{target.kind === "doc" ? "Doc" : "PDF"}</span>
                <Link href={target.href}>{target.title}</Link>
              </div>
            ))}
          </div>
        ),
    },
    { key: "createdBy", header: "Created by", sortKey: "createdBy", nowrap: true, cell: (row) => row.createdByName },
    {
      key: "created",
      header: "Created at",
      sortKey: "created",
      nowrap: true,
      cell: (row) => formatDate(row.createdAt, "yyyy-MM-dd HH:mm"),
    },
    {
      key: "minted",
      header: "Minted at",
      sortKey: "minted",
      nowrap: true,
      // "Minted" is the feature's own word for the moment Copy link turns a
      // draft into a URL (docs/ANCHORED_LINKS.md). A blank here would read as
      // missing data; it is a state.
      cell: (row) => (row.mintedAt ? formatDate(row.mintedAt, "yyyy-MM-dd HH:mm") : <em>draft</em>),
    },
    {
      key: "id",
      header: "Id",
      sortKey: "id",
      nowrap: true,
      defaultHidden: true,
      cellProps: () => ({ className: styles.idCell }),
      cell: (row) => row.id,
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
        <RowActionButton
          deleted={row.deleted}
          noun="link"
          disabled={pending || !row.canManage}
          onClick={() => handleDeleteToggle(row)}
        />
      ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  function handleDeleteToggle(row: LinkRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreAnchoredLink(row.id);
          } else {
            await deleteAnchoredLink(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update link.");
      }
    });
  }

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search passages, titles or creator…"
          label="Search links"
        />
        <OwnerFilterPanel
          options={ownerOptions}
          selected={filters.owners}
          // No `mode`: a link has one creator, so there is nothing for a Match
          // select to combine (src/lib/links-query.ts). The panel reports
          // /docs' key names; this table's is `owners`, renamed on the way in.
          onChange={({ authors }) => updateFilters({ owners: authors })}
          label="Owners"
          noun="owner"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<LinksFilters>)}
          onReset={() => navigate({ cols: null } as Partial<LinksFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("links", cols);
            navigate({ cols: null } as Partial<LinksFilters>);
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
              <EmptyRow colSpan={visibleColumns.length} message="No links matching the criteria." />
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
        noun="links"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the quoted passages and target titles you may read, and the creator's name/email."
        filters={[
          {
            param: "owners",
            meaning: (
              <>
                Comma-separated user slugs; shows links created by any of them. The list offers only people who
                created a link you may see here, and a slug outside it is dropped rather than honoured. No{" "}
                <code>ownerMode</code>, unlike /files: a link has one creator, so there is nothing to combine.
              </>
            ),
            control: "Owners dropdown",
          },
        ]}
        deepLinks={[
          deepLinkEntry("user", "A user id; shows only links that person created — the id-keyed twin of owners."),
          deepLinkEntry("doc", "A doc id; shows only links with a passage in that doc."),
          deepLinkEntry("file", "A file id; shows only links with a passage in that PDF."),
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            A row lists a link you created, or a minted link at least one of whose passages you may read.{" "}
            <strong>Passages</strong> and <strong>Targets</strong> show only the parts you could follow — a passage in
            a doc or PDF you can&apos;t read is left out without a trace, exactly as it is when following the link —
            so neither column sorts: what they show depends on who is looking, and nothing in the database could
            order rows the way a given viewer sees them. Passages links to the link&apos;s excerpt page (
            <code>/link/&lt;id&gt;?noredirect=1</code>); each target opens in context with its passages highlighted.{" "}
            <strong>Minted at</strong> is blank-as-<em>draft</em> only for your own open draft, which this table lists
            but cannot delete — discard it from its tray. Deleting a minted link is a soft delete by its creator or
            an ADMIN/EDITOR (docs/PERMISSIONS.md): the URL stops resolving for everyone until the link is restored.{" "}
            <strong>Id</strong> and <strong>Deleted at</strong> are hidden by default (Columns picker, above).
          </p>
        }
      />
    </>
  );
}
