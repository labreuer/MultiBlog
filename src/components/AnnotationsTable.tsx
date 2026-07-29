"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import { nextSortColumns } from "@/lib/use-sortable-rows";
import { DATE_FORMATS, type DateFormat, formatDate } from "@/lib/format-date";
import {
  PAGE_SIZE_OPTIONS,
  type AnnotationsFilters,
  type AnnotationsSortKey,
  buildAnnotationsQueryString,
} from "@/lib/annotations-query";
import { deleteAnnotation, restoreAnnotation } from "@/app/actions/annotations";
import adminStyles from "./AdminTable.module.css";

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

// A much smaller sibling of CommentsTable (PLAN.md §12j): no status/thread-
// status filters, no moderation buttons, no bulk actions — the only action
// an annotation supports is Delete/Restore, already a per-row icon button.
export default function AnnotationsTable({
  rows,
  totalCount,
  filters,
}: {
  rows: AnnotationRow[];
  totalCount: number;
  filters: AnnotationsFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd HH:mm");
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A row this tab just deleted, kept visible until fresh server data
  // (rows, after router.refresh()) either confirms or supersedes it — see
  // displayRows below, which drops an overlay entry the instant `rows`
  // itself contains that id again. Restoring needs no matching cleanup:
  // once refreshed `rows` shows deleted:false, the overlay is already
  // filtered out by that same rule (CommentsTable.tsx uses the identical
  // pattern).
  const [revealedRows, setRevealedRows] = useState<Map<string, AnnotationRow>>(new Map());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const prevSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the URL (an external system)
    setSearchDraft(filters.q);
  }, [filters.q]);

  useEffect(() => {
    const current = searchParams.toString();
    if (prevSearchParamsRef.current !== current) {
      prevSearchParamsRef.current = current;
      setRevealedRows(new Map());
    }
  }, [searchParams]);

  function navigate(partial: Partial<AnnotationsFilters>) {
    const nextFilters: AnnotationsFilters = { ...filters, ...partial };
    const qs = buildAnnotationsQueryString(nextFilters, searchParams);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function updateFilters(partial: Partial<AnnotationsFilters>) {
    navigate({ page: 1, ...partial });
  }

  function handleSearchChange(value: string) {
    setSearchDraft(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => updateFilters({ q: value }), 400);
  }

  function handleSort(key: AnnotationsSortKey, addToSort: boolean) {
    updateFilters({ sort: nextSortColumns(filters.sort, key, addToSort) });
  }

  function sortIndicator(key: AnnotationsSortKey) {
    const idx = filters.sort.findIndex((c) => c.key === key);
    if (idx === -1) return null;
    return (
      <>
        {" "}
        {filters.sort[idx].dir === "asc" ? "▲" : "▼"}
        {idx > 0 && <sup>{idx + 1}</sup>}
      </>
    );
  }

  function handleDeleteToggle(row: AnnotationRow) {
    setError(null);
    startTransition(async () => {
      try {
        if (row.deleted) {
          await restoreAnnotation(row.id);
        } else {
          await deleteAnnotation(row.id);
          setRevealedRows((prev) => new Map(prev).set(row.id, { ...row, deleted: true }));
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update annotation.");
      }
    });
  }

  const displayRows = useMemo(() => {
    const overlayOnly = [...revealedRows.values()].filter((r) => !rows.some((row) => row.id === r.id));
    return [...rows, ...overlayOnly];
  }, [rows, revealedRows]);
  const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));
  const currentPage = Math.min(filters.page, totalPages);

  return (
    <>
      <div className={adminStyles.filterRow}>
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search body or doc title…"
          aria-label="Search"
          style={{ padding: "6px 12px" }}
        />
      </div>

      <table className={adminStyles.table}>
        <thead>
          <tr>
            <th className={adminStyles.sortableHeaderCell} onClick={(e) => handleSort("doc", e.ctrlKey)}>
              Doc{sortIndicator("doc")}
            </th>
            <th className={adminStyles.sortableHeaderCell} onClick={(e) => handleSort("author", e.ctrlKey)}>
              Author{sortIndicator("author")}
            </th>
            <th className={adminStyles.headerCell}>Body</th>
            <th className={adminStyles.headerCell}>Quote</th>
            <th className={adminStyles.nowrapSortableHeaderCell} onClick={(e) => handleSort("created", e.ctrlKey)}>
              Created{sortIndicator("created")}
            </th>
            <th className={adminStyles.nowrapSortableHeaderCell} onClick={(e) => handleSort("edited", e.ctrlKey)}>
              Edited{sortIndicator("edited")}
            </th>
            <th className={adminStyles.sortableHeaderCell} onClick={(e) => handleSort("deleted", e.ctrlKey)}>
              Deleted{sortIndicator("deleted")}
            </th>
            <th className={adminStyles.headerCell}></th>
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <tr>
              <td colSpan={8} className={adminStyles.emptyRow}>
                No annotations matching the criteria.
              </td>
            </tr>
          )}
          {displayRows.map((row) => (
            <tr key={row.id} className={row.deleted ? `${adminStyles.row} ${adminStyles.rowDeleted}` : adminStyles.row}>
              <td className={adminStyles.cell}>
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
                <button
                  type="button"
                  onClick={() => handleDeleteToggle(row)}
                  disabled={pending}
                  aria-label={row.deleted ? "Restore annotation" : "Delete annotation"}
                  title={row.deleted ? "Restore annotation" : "Delete annotation"}
                  className={`${adminStyles.iconButton} ${row.deleted ? adminStyles.iconButtonMuted : adminStyles.iconButtonDanger}`}
                >
                  {row.deleted ? <IconTrashOff size={16} /> : <IconTrash size={16} />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <div className={adminStyles.paginationBar}>
        <span>
          Rows per page:{" "}
          <select
            value={filters.pageSize}
            onChange={(e) => updateFilters({ pageSize: Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number] })}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </span>
        <span>
          {totalCount === 0
            ? "0 annotations"
            : `${(currentPage - 1) * filters.pageSize + 1}–${Math.min(currentPage * filters.pageSize, totalCount)} of ${totalCount}`}
        </span>
        <button type="button" onClick={() => navigate({ page: currentPage - 1 })} disabled={currentPage <= 1}>
          ◀ Prev
        </button>
        <span>
          Page {currentPage} of {totalPages}
        </span>
        <button type="button" onClick={() => navigate({ page: currentPage + 1 })} disabled={currentPage >= totalPages}>
          Next ▶
        </button>
      </div>

      <div className={adminStyles.dateFormatRow}>
        Date format:{" "}
        <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
          {DATE_FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </div>

      <label className={adminStyles.showDeletedRow}>
        <input type="checkbox" checked={filters.deleted} onChange={(e) => updateFilters({ deleted: e.target.checked })} /> Show
        deleted rows
      </label>
    </>
  );
}
