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
import {
  buildWikiPagesQueryString,
  namespaceParam,
  type NamespaceFilter,
  type WikiPagesFilters,
} from "@/lib/wiki-pages-query";
import { decodeSegment, ownerSegment, wikiNamespacePath, type WikiOwner } from "@/lib/wiki-address";
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
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import {
  registryColumns,
  resolveColumns,
  type ColumnBody,
  type ColumnSpec,
} from "@/components/table/column-spec";
import type { AdminColumnKey } from "@/lib/admin-table-columns";
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
import { TagListCell } from "@/components/tags/TagChipList";
import BulkTagPicker from "@/components/tags/BulkTagPicker";
import { bulkTagObjects } from "@/app/actions/tags";
import type { TagLink } from "@/lib/tag-data";
import styles from "./WikiPagesTable.module.css";

export type WikiPageRow = {
  id: string;
  namespace: WikiOwner;
  // The name as stored, with its spaces, and the variant, "" for the page itself.
  name: string;
  variant: string;
  // The page's address; null for a deleted page, whose address answers nothing.
  path: string | null;
  // Its wiki editor, or /doc/<id>/edit for a deleted page (docs/WIKI.md
  // "Deleting a page"). Shown only when canEdit.
  editPath: string;
  authors: string;
  visibility: DocVisibility;
  // allowedVisibilities (src/lib/doc-visibility.ts), worked out on the page:
  // what setDocVisibility would accept from this viewer.
  visibilities: DocVisibility[];
  updatedAt: Date;
  length: number;
  // Null when withheld: a PRIVATE page only the ADMIN override lists.
  tags: TagLink[] | null;
  // The parent, named only when the viewer can read it (docs/FORKS.md); null
  // when the page isn't a fork.
  forkedFrom: { kind: "named"; title: string; path: string } | { kind: "hidden" } | null;
  deletedAt: Date | null;
  deleted: boolean;
  // docs/WIKI.md "Permissions", "Each row of the wiki table says what may be
  // done to it". canEdit is canEditDocRow; canSetVisibility adds an ADMIN's
  // lowering of a person's page; canDelete is a person's page's owner alone,
  // or a commons page's editors. Affordances only: doc-manage.ts asks again.
  canEdit: boolean;
  canSetVisibility: boolean;
  canDelete: boolean;
  // Its read rule (docs/TAGS.md, "Who may tag"). False only on a row the ADMIN
  // "Show all" override lists.
  canTag: boolean;
};

const SORTABLE_KEYS = [
  "namespace",
  "name",
  "variant",
  "visibility",
  "authors",
  "updatedAt",
  "length",
  "tags",
  "forkedFrom",
  "deletedAt",
  "deleted",
] as const;

/** A restored page's address as a reader sees it: decoded, so a name reads with its `_` and nothing else encoded. */
function readablePath(path: string): string {
  return decodeSegment(path) ?? path;
}

export default function WikiPagesTable({
  rows,
  totalCount,
  filters,
  prefs,
  isAdmin,
  ownerSlugs,
}: {
  rows: WikiPageRow[];
  totalCount: number;
  filters: WikiPagesFilters;
  prefs: TablePrefs;
  /** Whether to render the ADMIN-only "Show all" checkbox, as /docs does. */
  isAdmin: boolean;
  /** The owners with a page in this listing, for the namespace filter. */
  ownerSlugs: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildWikiPagesQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  const bulkActions: BulkAction<WikiPageRow>[] = [
    {
      kind: "picker",
      key: "tag",
      label: "Tag",
      applicableTo: (row) => !row.deleted && row.canTag,
      render: (apply, pending) => <BulkTagPicker apply={apply} pending={pending} />,
      run: (ids, tagId) => bulkTagObjects(tagId, "doc", ids),
    },
    {
      kind: "select",
      key: "visibility",
      label: "Set visibility",
      options: Object.values(DocVisibility),
      allows: (row, value) => row.visibilities.includes(value as DocVisibility),
      applicableTo: (row) => !row.deleted && row.canSetVisibility,
      run: (ids, value) => bulkSetDocVisibility(ids, value as DocVisibility),
    },
    ...softDeleteBulkActions<WikiPageRow>("pages", bulkDeleteDocs, bulkRestoreDocs, (row) => row.canDelete),
  ];

  // What each movable column does, keyed by its entry in src/lib/admin-table-columns.ts, which
  // owns its header, default visibility and order.
  const columnBodies: Record<AdminColumnKey<"wiki">, ColumnBody<WikiPageRow>> = {
    namespace: {
      sortKey: "namespace",
      nowrap: true,
      cell: (row) => <Link href={wikiNamespacePath(row.namespace)}>{ownerSegment(row.namespace)}</Link>,
    },
    name: {
      sortKey: "name",
      cellProps: (row) => ({
        className: row.path ? styles.nameCell : undefined,
        onClick: (e) => {
          if (row.path && (!(e.target instanceof Element) || !e.target.closest("a"))) router.push(row.path);
        },
      }),
      cell: (row) => (row.path ? <Link href={row.path}>{row.name}</Link> : row.name),
    },
    variant: { sortKey: "variant", nowrap: true, cell: (row) => row.variant },
    edit: {
      cell: (row) => row.canEdit && <Link href={row.editPath}>edit</Link>,
    },
    authors: { sortKey: "authors", cell: (row) => row.authors },
    visibility: {
      sortKey: "visibility",
      cell: (row) => (
        <SelectCell
          value={row.visibility}
          options={row.visibilities}
          disabled={row.deleted || !row.canSetVisibility}
          save={(next) => updateDocVisibility(row.id, next)}
          failureMessage="Failed to update visibility."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    updatedAt: {
      sortKey: "updatedAt",
      nowrap: true,
      cell: (row) => formatDate(row.updatedAt, "yyyy-MM-dd HH:mm"),
    },
    length: {
      sortKey: "length",
      nowrap: true,
      cell: (row) => row.length.toLocaleString(),
    },
    tags: {
      // No sort arrows under "Show all", where the page has dropped this key
      // from the sort, as on /docs.
      sortKey: isAdmin && filters.showAll ? undefined : "tags",
      cell: (row) => <TagListCell tags={row.tags} noun="page" />,
    },
    forkedFrom: {
      sortKey: "forkedFrom",
      cell: (row) =>
        row.forkedFrom === null ? (
          ""
        ) : row.forkedFrom.kind === "named" ? (
          <Link href={row.forkedFrom.path}>{row.forkedFrom.title}</Link>
        ) : (
          <span className={styles.hiddenParent}>a doc you can&apos;t read</span>
        ),
    },
    deletedAt: {
      sortKey: "deletedAt",
      nowrap: true,
      cell: (row) => (row.deletedAt ? formatDate(row.deletedAt, "yyyy-MM-dd HH:mm") : ""),
    },
  };
  const columns: ColumnSpec<WikiPageRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`page ${row.name}`}
        />
      ),
    },
    ...registryColumns("wiki", columnBodies),
    {
      key: "deleted",
      alwaysVisible: true,
      header: "Deleted",
      renderHeader: () => <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />,
      cell: (row) =>
        row.canDelete && (
          <RowActionButton
            deleted={row.deleted}
            noun="page"
            disabled={pending}
            onClick={() => handleDeleteToggle(row)}
          />
        ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  function handleDeleteToggle(row: WikiPageRow) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            // A page whose address was taken while it was deleted comes back
            // at the next free variant, which the row alone wouldn't explain.
            const { wikiPath, renamedFrom } = await restoreDoc(row.id);
            if (wikiPath && renamedFrom) {
              setNotice(
                `${readablePath(renamedFrom)} now belongs to another page, so this one was restored at ${readablePath(wikiPath)}.`,
              );
            }
          } else {
            await deleteDoc(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update page.");
      }
    });
  }

  const namespaceValue = namespaceParam(filters.namespace);
  const namespaceOptions: { value: string; filter: NamespaceFilter }[] = [
    { value: "commons", filter: { kind: "commons" } },
    ...ownerSlugs.map((slug) => ({ value: `@${slug}`, filter: { kind: "person" as const, slug } })),
  ];

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox value={searchDraft} onChange={onSearchChange} placeholder="Search name …" label="Search name" />
        <label>
          Namespace:{" "}
          <select
            value={namespaceValue}
            onChange={(e) =>
              updateFilters({
                namespace: namespaceOptions.find((o) => o.value === e.target.value)?.filter ?? null,
              })
            }
          >
            <option value="">All</option>
            {namespaceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Visibility:{" "}
          <select
            value={filters.visibility ?? ""}
            onChange={(e) =>
              updateFilters({ visibility: e.target.value ? (e.target.value as DocVisibility) : null })
            }
          >
            <option value="">All</option>
            {Object.values(DocVisibility).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<WikiPagesFilters>)}
          onReset={() => navigate({ cols: null } as Partial<WikiPagesFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("wiki", cols);
            navigate({ cols: null } as Partial<WikiPagesFilters>);
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
              <EmptyRow colSpan={visibleColumns.length} message="No wiki pages matching the criteria." />
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
      <CellError message={notice} tone="notice" />

      <PaginationBar
        totalCount={totalCount}
        page={filters.page}
        pageSize={filters.pageSize}
        noun="pages"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />
      {isAdmin && (
        <p className={styles.showAllRow}>
          <label>
            <input
              type="checkbox"
              checked={filters.showAll}
              onChange={(e) => updateFilters({ showAll: e.target.checked })}
            />{" "}
            Show all pages (bypasses PRIVATE authorship for this listing only)
          </label>
        </p>
      )}

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over the page's name."
        filters={[
          {
            param: "namespace",
            meaning: (
              <>
                <code>commons</code>, or <code>@</code> and a person&apos;s slug, as an address writes it. A slug that
                owns no page in this listing is dropped rather than honoured.
              </>
            ),
            control: "Namespace dropdown",
          },
          {
            param: "visibility",
            meaning: (
              <>
                <code>PRIVATE</code>, <code>SHARED</code> or <code>PUBLIC</code>; omitted lists all three.
              </>
            ),
            control: "Visibility dropdown",
          },
          {
            param: "showAll",
            meaning: (
              <>
                <code>1</code> lists every page, PRIVATE ones you aren&apos;t on included. ADMIN only; ignored for
                anyone else.
              </>
            ),
            control: "Show all pages checkbox",
          },
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            Every column here sorts except <strong>Edit</strong>, which is a link rather than a value.{" "}
            <strong>Namespace</strong> sorts by the owner&apos;s slug, with the commons after every person ascending.{" "}
            <strong>Name</strong> sorts by its folded key, so case doesn&apos;t order it. <strong>Forked from</strong>{" "}
            sorts by which doc a page was forked from, keeping a doc&apos;s forks together, rather than by its title:
            a parent you can&apos;t read isn&apos;t named, and ordering by its title would place it among the ones
            that are. This listing holds the wiki pages <code>/docs</code> would list: every <strong>SHARED</strong>{" "}
            or <strong>PUBLIC</strong> page to an ADMIN or EDITOR, plus the pages you carry a byline on. A
            person&apos;s page is edited by its byline alone, deleted and restored by its owner alone, and made more
            visible by its owner alone; an ADMIN may lower its visibility from here. A row offers only what you may do
            to it.
          </p>
        }
      />
    </>
  );
}
