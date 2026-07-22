"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import { nextSortColumns } from "@/lib/use-sortable-rows";
import { DATE_FORMATS, type DateFormat, formatDate } from "@/lib/format-date";
import {
  STATUS_OPTIONS,
  THREAD_STATUS_OPTIONS,
  PAGE_SIZE_OPTIONS,
  type CommentsFilters,
  type CommentsSortKey,
  buildCommentsQueryString,
} from "@/lib/comments-query";
import {
  moderateComment,
  deleteComment,
  restoreComment,
  bulkModerateComments,
  bulkDeleteComments,
  bulkRestoreComments,
} from "@/app/actions/comments";
import type { CommentStatus, ThreadStatus } from "@/generated/prisma/enums";
import styles from "./AdminTable.module.css";

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

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };
const sortableTh: React.CSSProperties = { ...th, cursor: "pointer", userSelect: "none" };
const nowrapTd: React.CSSProperties = { ...td, whiteSpace: "nowrap" };
const nowrapSortableTh: React.CSSProperties = { ...sortableTh, whiteSpace: "nowrap" };
const helpTh: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #ccc" };
const helpTd: React.CSSProperties = { padding: "4px 8px", verticalAlign: "top", borderBottom: "1px solid #eee" };

function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly T[];
  selected: Set<T> | "ALL";
  onChange: (next: Set<T> | "ALL") => void;
}) {
  const summary = selected === "ALL" ? "All" : options.filter((o) => selected.has(o)).join(", ") || "All";
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // <details> has no native "close on outside click" behavior — only
  // toggles via its own <summary>. Set .open directly on the DOM node
  // (rather than lifting it into React state) since nothing else here needs
  // to react to open/closed.
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (detailsRef.current && !detailsRef.current.contains(e.target as Node)) {
        detailsRef.current.open = false;
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  return (
    <details ref={detailsRef} style={{ display: "inline-block", position: "relative" }}>
      <summary style={{ cursor: "pointer", padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, listStyle: "none" }}>
        {label}: {summary}
      </summary>
      <div
        style={{
          position: "absolute",
          zIndex: 1,
          background: "white",
          border: "1px solid #ccc",
          borderRadius: 4,
          padding: 8,
          marginTop: 4,
          whiteSpace: "nowrap",
        }}
      >
        <label style={{ display: "block", padding: "2px 0" }}>
          <input type="checkbox" checked={selected === "ALL"} onChange={() => onChange("ALL")} /> All
        </label>
        {options.map((option) => (
          <label key={option} style={{ display: "block", padding: "2px 0" }}>
            <input
              type="checkbox"
              checked={selected !== "ALL" && selected.has(option)}
              onChange={(e) => {
                const current = selected === "ALL" ? new Set<T>() : new Set(selected);
                if (e.target.checked) current.add(option);
                else current.delete(option);
                onChange(current.size === 0 ? "ALL" : current);
              }}
            />{" "}
            {option}
          </label>
        ))}
      </div>
    </details>
  );
}

function ActionCell({ comment, disabled }: { comment: CommentRow; disabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const handle = (action: "approve" | "pend" | "spam") => {
    startTransition(async () => {
      await moderateComment(comment.id, action);
      router.refresh();
    });
  };
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button
        type="button"
        onClick={() => handle("approve")}
        disabled={disabled || pending || comment.status === "APPROVED"}
        className={`${styles.actionButton} ${styles.approve}`}
      >
        Approve
      </button>
      <button
        type="button"
        onClick={() => handle("pend")}
        disabled={disabled || pending || comment.status === "PENDING"}
        className={`${styles.actionButton} ${styles.pend}`}
      >
        Pend
      </button>
      <button
        type="button"
        onClick={() => handle("spam")}
        disabled={disabled || pending || comment.status === "SPAM"}
        className={`${styles.actionButton} ${styles.spam}`}
      >
        Spam
      </button>
    </div>
  );
}

function DeleteCell({
  comment,
  onDeleted,
}: {
  comment: CommentRow;
  onDeleted: (row: CommentRow) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setError(null);
    startTransition(async () => {
      try {
        if (comment.deleted) {
          await restoreComment(comment.id);
        } else {
          await deleteComment(comment.id);
          onDeleted(comment);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update comment.");
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={handle}
        disabled={pending}
        aria-label={comment.deleted ? "Restore comment" : "Delete comment"}
        title={comment.deleted ? "Restore comment" : "Delete comment"}
        style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: comment.deleted ? "#666" : "#c00" }}
      >
        {comment.deleted ? <IconTrashOff size={16} /> : <IconTrash size={16} />}
      </button>
      {error && <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>}
    </>
  );
}

export default function CommentsTable({
  rows,
  totalCount,
  filters,
}: {
  rows: CommentRow[];
  totalCount: number;
  filters: CommentsFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Rows deleted (or bulk-deleted) during this visit are kept visible —
  // deleting one row shouldn't yank it out of view when `deleted` isn't
  // shown, since the server refetch that follows won't include it anymore.
  // Cleared whenever the URL's querystring actually changes (a real
  // filter/sort/page navigation), but not by the same-URL refresh a
  // delete/restore/moderate action triggers.
  const [revealedRows, setRevealedRows] = useState<Map<string, CommentRow>>(new Map());
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const prevSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    const current = searchParams.toString();
    if (prevSearchParamsRef.current !== current) {
      prevSearchParamsRef.current = current;
      setRevealedRows(new Map());
    }
  }, [searchParams]);

  // Keeps the search box in sync when `filters.q` changes for a reason other
  // than this component's own debounced navigation (e.g. browser back/
  // forward, or a deep link with ?q= already set) — a no-op the rest of the
  // time, since by then searchDraft already equals filters.q.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the URL (an external system), see above
    setSearchDraft(filters.q);
  }, [filters.q]);

  function navigate(partial: Partial<CommentsFilters>) {
    const nextFilters: CommentsFilters = { ...filters, ...partial };
    const qs = buildCommentsQueryString(nextFilters, searchParams);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Any filter/sort/page-size change resets to page 1; only Prev/Next
  // (which call `navigate` directly) are meant to change just the page.
  function updateFilters(partial: Partial<CommentsFilters>) {
    navigate({ page: 1, ...partial });
  }

  function handleSearchChange(value: string) {
    setSearchDraft(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => updateFilters({ q: value }), 400);
  }

  function handleSort(key: CommentsSortKey, addToSort: boolean) {
    updateFilters({ sort: nextSortColumns(filters.sort, key, addToSort) });
  }

  function sortIndicator(key: CommentsSortKey) {
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

  function revealRow(row: CommentRow) {
    setRevealedRows((prev) => new Map(prev).set(row.id, { ...row, deleted: true }));
  }

  const displayRows = useMemo(() => {
    const overlayOnly = [...revealedRows.values()].filter((r) => !rows.some((row) => row.id === r.id));
    return [...rows, ...overlayOnly];
  }, [rows, revealedRows]);

  const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));
  const currentPage = Math.min(filters.page, totalPages);

  const allVisibleSelected = displayRows.length > 0 && displayRows.every((r) => selectedIds.has(r.id));

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const row of displayRows) next.delete(row.id);
        return next;
      }
      return new Set([...prev, ...displayRows.map((r) => r.id)]);
    });
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulk(action: "approve" | "pend" | "spam" | "delete" | "restore") {
    setBulkError(null);
    const selected = displayRows.filter((r) => selectedIds.has(r.id));
    const targetRows =
      action === "restore" ? selected.filter((r) => r.deleted) : selected.filter((r) => !r.deleted);
    if (targetRows.length === 0) return;
    const targetIds = targetRows.map((r) => r.id);

    setBulkPending(true);
    try {
      if (action === "approve") await bulkModerateComments(targetIds, "approve");
      else if (action === "pend") await bulkModerateComments(targetIds, "pend");
      else if (action === "spam") await bulkModerateComments(targetIds, "spam");
      else if (action === "delete") await bulkDeleteComments(targetIds);
      else await bulkRestoreComments(targetIds);

      if (action === "delete") {
        setRevealedRows((prev) => {
          const next = new Map(prev);
          for (const row of targetRows) next.set(row.id, { ...row, deleted: true });
          return next;
        });
      }
      setSelectedIds(new Set());
      router.refresh();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Bulk action failed.");
    } finally {
      setBulkPending(false);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search comment or commenter …"
          aria-label="Search comments"
          style={{ padding: "6px 12px", minWidth: 240 }}
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

      {selectedIds.size > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "#f5f5f5",
            border: "1px solid #ddd",
            borderRadius: 4,
            padding: "8px 12px",
            marginBottom: 8,
          }}
        >
          <span>{selectedIds.size} selected</span>
          <button
            type="button"
            disabled={bulkPending}
            onClick={() => runBulk("approve")}
            className={`${styles.actionButton} ${styles.approve}`}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={bulkPending}
            onClick={() => runBulk("pend")}
            className={`${styles.actionButton} ${styles.pend}`}
          >
            Pend
          </button>
          <button
            type="button"
            disabled={bulkPending}
            onClick={() => runBulk("spam")}
            className={`${styles.actionButton} ${styles.spam}`}
          >
            Spam
          </button>
          <button
            type="button"
            disabled={bulkPending}
            onClick={() => runBulk("delete")}
            aria-label="Delete selected"
            title="Delete selected"
            style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "#c00", marginLeft: "4em" }}
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            disabled={bulkPending}
            onClick={() => runBulk("restore")}
            aria-label="Restore selected"
            title="Restore selected"
            style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "#666" }}
          >
            <IconTrashOff size={16} />
          </button>
          {bulkError && <span style={{ color: "crimson" }}>{bulkError}</span>}
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse" }} className={styles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th style={th}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Select all rows" />
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("post", e.ctrlKey)}>
              Post{sortIndicator("post")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("commenter", e.ctrlKey)}>
              Commenter{sortIndicator("commenter")}
            </th>
            <th style={th}>Comment</th>
            <th style={sortableTh} onClick={(e) => handleSort("status", e.ctrlKey)}>
              Status{sortIndicator("status")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("threadStatus", e.ctrlKey)}>
              Thread{sortIndicator("threadStatus")}
            </th>
            <th style={nowrapSortableTh} onClick={(e) => handleSort("created", e.ctrlKey)}>
              Created at{sortIndicator("created")}
            </th>
            <th style={nowrapSortableTh} onClick={(e) => handleSort("statusChanged", e.ctrlKey)}>
              Status changed{sortIndicator("statusChanged")}
            </th>
            <th style={th}>Commenter activity</th>
            <th style={th}>Action</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <tr>
              <td colSpan={11} style={td} className={styles.emptyRow}>
                (no comments matching the criteria)
              </td>
            </tr>
          )}
          {displayRows.map((row) => (
            <tr key={row.id} style={{ borderBottom: "1px solid #eee", opacity: row.deleted ? 0.5 : 1 }}>
              <td style={td}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(row.id)}
                  onChange={() => toggleRow(row.id)}
                  aria-label={`Select comment from ${row.commenterName}`}
                />
              </td>
              <td style={td}>
                <Link href={`/posts/${row.postId}/comments`}>{row.postTitle}</Link>
              </td>
              <td style={td}>
                {row.commenterName} <span style={{ color: "#666" }}>({row.commenterEmail})</span>
              </td>
              <td style={{ ...td, maxWidth: 320 }}>{row.bodyText}</td>
              <td style={td}>{row.status}</td>
              <td style={td}>{row.threadStatus}</td>
              <td style={nowrapTd}>{formatDate(row.createdAt, dateFormat)}</td>
              <td style={nowrapTd}>{row.statusChangedAt ? formatDate(row.statusChangedAt, dateFormat) : ""}</td>
              <td style={nowrapTd}>
                {row.commenterCounts.submitted} / {row.commenterCounts.inModeration} / {row.commenterCounts.spam}
              </td>
              <td style={td}>
                <ActionCell comment={row} disabled={row.deleted} />
              </td>
              <td style={td}>
                <DeleteCell comment={row} onDeleted={revealRow} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 12 }} className={styles.paginationBar}>
        <label>
          Rows per page:{" "}
          <select value={filters.pageSize} onChange={(e) => updateFilters({ pageSize: Number(e.target.value) as CommentsFilters["pageSize"] })}>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span>
          {totalCount === 0
            ? "0 comments"
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

      <p style={{ marginTop: 12 }}>
        <label>
          Date format:{" "}
          <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
            {DATE_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p style={{ marginTop: 8 }}>
        <label>
          <input
            type="checkbox"
            checked={filters.deleted}
            onChange={(e) => updateFilters({ deleted: e.target.checked })}
          />{" "}
          Show deleted rows
        </label>
      </p>

      <details style={{ marginTop: "1em", marginBottom: "1em", border: "1px solid #ddd", borderRadius: 4, padding: "8px 12px" }}>
        <summary style={{ cursor: "pointer", fontWeight: "bold" }}>Help: filtering &amp; the URL</summary>
        <div style={{ marginTop: 8, fontSize: "0.9rem", color: "#333" }}>
          <p>The filters below are mirrored into the page&apos;s querystring, so a filtered view can be bookmarked or shared.</p>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={helpTh}>Param</th>
                <th style={helpTh}>Meaning</th>
                <th style={helpTh}>Control</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={helpTd}>
                  <code>status</code>
                </td>
                <td style={helpTd}>Comma-separated {STATUS_OPTIONS.join(", ")}; omitted means all.</td>
                <td style={helpTd}>Status dropdown</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>threadStatus</code>
                </td>
                <td style={helpTd}>Comma-separated {THREAD_STATUS_OPTIONS.join(", ")}; omitted means all.</td>
                <td style={helpTd}>Thread status dropdown</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>deleted</code>
                </td>
                <td style={helpTd}>
                  <code>1</code> to include deleted comments; omitted hides them.
                </td>
                <td style={helpTd}>Show deleted rows checkbox</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>q</code>
                </td>
                <td style={helpTd}>Free-text search over the comment body and commenter name/email.</td>
                <td style={helpTd}>Search box</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>page</code> / <code>pageSize</code>
                </td>
                <td style={helpTd}>1-indexed page number, and rows per page ({PAGE_SIZE_OPTIONS.join(", ")}).</td>
                <td style={helpTd}>Prev/Next and rows-per-page dropdown</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>sort</code>
                </td>
                <td style={helpTd}>
                  Comma-separated <code>key:asc</code>/<code>key:desc</code> pairs; ctrl-click a column to add it as a
                  secondary sort key.
                </td>
                <td style={helpTd}>Click a column header</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>post</code>
                </td>
                <td style={helpTd}>A post id; shows only that post&apos;s comments.</td>
                <td style={helpTd}>Deep link only — edit the URL</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>author</code>
                </td>
                <td style={helpTd}>A user id; shows only comments on posts that user is credited as an author of.</td>
                <td style={helpTd}>Deep link only — edit the URL</td>
              </tr>
              <tr>
                <td style={helpTd}>
                  <code>commenter</code>
                </td>
                <td style={helpTd}>A commenter id; shows only that person&apos;s comments.</td>
                <td style={helpTd}>Deep link only — edit the URL</td>
              </tr>
            </tbody>
          </table>
          <p style={{ marginTop: 8 }}>
            The <strong>Commenter activity</strong> column reads {"{submitted} / {in moderation} / {spam}"} — counts of
            that commenter&apos;s non-deleted comments visible on this page (an author only sees counts scoped to their
            own posts), independent of the current status/thread-status/search filters.
          </p>
        </div>
      </details>
    </>
  );
}
