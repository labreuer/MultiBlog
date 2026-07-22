"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import { useSortableRows } from "@/lib/use-sortable-rows";
import { DATE_FORMATS, type DateFormat, formatDate } from "@/lib/format-date";
import {
  moderateComment,
  deleteComment,
  restoreComment,
  bulkModerateComments,
  bulkDeleteComments,
  bulkRestoreComments,
} from "@/app/actions/comments";
import type { CommentStatus, ThreadStatus } from "@/generated/prisma/enums";

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

const STATUS_OPTIONS: CommentStatus[] = ["PENDING", "APPROVED", "SPAM"];
const THREAD_STATUS_OPTIONS: ThreadStatus[] = ["ACTIVE", "DETACHED", "RESOLVED"];

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };
const sortableTh: React.CSSProperties = { ...th, cursor: "pointer", userSelect: "none" };
const nowrapTd: React.CSSProperties = { ...td, whiteSpace: "nowrap" };
const nowrapSortableTh: React.CSSProperties = { ...sortableTh, whiteSpace: "nowrap" };
const helpTh: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid #ccc" };
const helpTd: React.CSSProperties = { padding: "4px 8px", verticalAlign: "top", borderBottom: "1px solid #eee" };

// Selection is either "every option" (the ALL checkbox, the default — no
// querystring param) or an explicit subset. Unchecking every individual
// option snaps back to ALL rather than leaving an unusable empty selection.
function parseSetParam<T extends string>(value: string | null, all: readonly T[]): Set<T> | "ALL" {
  if (!value) return "ALL";
  const parts = value.split(",").filter((p): p is T => (all as readonly string[]).includes(p as T));
  return parts.length > 0 ? new Set(parts) : "ALL";
}

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

  return (
    <details style={{ display: "inline-block", position: "relative" }}>
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
      <button type="button" onClick={() => handle("approve")} disabled={disabled || pending || comment.status === "APPROVED"}>
        Approve
      </button>
      <button type="button" onClick={() => handle("pend")} disabled={disabled || pending || comment.status === "PENDING"}>
        Pend
      </button>
      <button type="button" onClick={() => handle("spam")} disabled={disabled || pending || comment.status === "SPAM"}>
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
  onDeleted: (id: string) => void;
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
          onDeleted(comment.id);
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

type SortKey = "post" | "commenter" | "status" | "threadStatus" | "created" | "statusChanged" | "counts";

function compareNullableDates(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature required by useSortableRows; no key here needs the direction
function compareByKey(key: SortKey, a: CommentRow, b: CommentRow, dir: "asc" | "desc"): number {
  switch (key) {
    case "post":
      return a.postTitle.localeCompare(b.postTitle);
    case "commenter":
      return a.commenterName.localeCompare(b.commenterName);
    case "status":
      return a.status.localeCompare(b.status);
    case "threadStatus":
      return a.threadStatus.localeCompare(b.threadStatus);
    case "created":
      return a.createdAt.getTime() - b.createdAt.getTime();
    case "statusChanged":
      return compareNullableDates(a.statusChangedAt, b.statusChangedAt);
    case "counts":
      return a.commenterCounts.submitted - b.commenterCounts.submitted;
  }
}

export default function CommentsTable({ rows }: { rows: CommentRow[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [searchText, setSearchText] = useState("");
  const [status, setStatus] = useState<Set<CommentStatus> | "ALL">("ALL");
  const [threadStatus, setThreadStatus] = useState<Set<ThreadStatus> | "ALL">("ALL");
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const initializedFromUrl = useRef(false);

  // Read initial filter state from the URL once, after mount — matches
  // useShowDeletedRows's pattern (see src/lib/use-show-deleted.ts): SSR has
  // no access to browser-only state here either, so seeding from
  // searchParams in the initializer would risk a hydration mismatch if this
  // page is ever server-rendered with a query string already attached.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing initial value from the URL (an external system); see use-show-deleted.ts
    setSearchText(searchParams.get("q") ?? "");
    setStatus(parseSetParam(searchParams.get("status"), STATUS_OPTIONS));
    setThreadStatus(parseSetParam(searchParams.get("threadStatus"), THREAD_STATUS_OPTIONS));
    setShowDeleted(searchParams.get("deleted") === "1");
    initializedFromUrl.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only, like useShowDeletedRows
  }, []);

  // Mirrors the filter UI into the URL via the plain history API (not
  // next/navigation's router) so the page never re-fetches from the server —
  // every filter here only narrows rows already loaded into `rows`.
  useEffect(() => {
    if (!initializedFromUrl.current) return;
    const params = new URLSearchParams();
    if (searchText.trim()) params.set("q", searchText.trim());
    if (status !== "ALL") params.set("status", [...status].join(","));
    if (threadStatus !== "ALL") params.set("threadStatus", [...threadStatus].join(","));
    if (showDeleted) params.set("deleted", "1");
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [searchText, status, threadStatus, showDeleted]);

  function revealRow(id: string) {
    setRevealedIds((prev) => new Set(prev).add(id));
  }

  const filteredRows = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return rows.filter((row) => {
      if (!showDeleted && row.deleted && !revealedIds.has(row.id)) return false;
      if (status !== "ALL" && !status.has(row.status)) return false;
      if (threadStatus !== "ALL" && !threadStatus.has(row.threadStatus)) return false;
      if (
        needle &&
        !row.bodyText.toLowerCase().includes(needle) &&
        !row.commenterName.toLowerCase().includes(needle) &&
        !row.commenterEmail.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
  }, [rows, searchText, status, threadStatus, showDeleted, revealedIds]);

  const { sortedRows, handleSort, sortState } = useSortableRows(filteredRows, compareByKey);

  function sortIndicator(key: SortKey) {
    const state = sortState(key);
    if (!state) return null;
    return (
      <>
        {" "}
        {state.dir === "asc" ? "▲" : "▼"}
        {state.priority > 1 && <sup>{state.priority}</sup>}
      </>
    );
  }

  const visibleIds = useMemo(() => new Set(sortedRows.map((r) => r.id)), [sortedRows]);
  const allVisibleSelected = sortedRows.length > 0 && sortedRows.every((r) => selectedIds.has(r.id));

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...visibleIds]);
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

  async function runBulk(action: "approve" | "spam" | "delete" | "restore") {
    setBulkError(null);
    const selected = sortedRows.filter((r) => selectedIds.has(r.id));
    const targetIds =
      action === "restore"
        ? selected.filter((r) => r.deleted).map((r) => r.id)
        : selected.filter((r) => !r.deleted).map((r) => r.id);
    if (targetIds.length === 0) return;

    setBulkPending(true);
    try {
      if (action === "approve") await bulkModerateComments(targetIds, "approve");
      else if (action === "spam") await bulkModerateComments(targetIds, "spam");
      else if (action === "delete") await bulkDeleteComments(targetIds);
      else await bulkRestoreComments(targetIds);

      if (action === "delete") {
        setRevealedIds((prev) => new Set([...prev, ...targetIds]));
      }
      setSelectedIds(new Set());
      router.refresh();
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Bulk action failed.");
    } finally {
      setBulkPending(false);
    }
  }

  if (rows.length === 0) {
    return <p>No comments yet.</p>;
  }

  return (
    <>
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
            own posts).
          </p>
        </div>
      </details>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <input
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search comment or commenter …"
          aria-label="Search comments"
          style={{ padding: "6px 12px", minWidth: 240 }}
        />
        <MultiSelectDropdown label="Status" options={STATUS_OPTIONS} selected={status} onChange={setStatus} />
        <MultiSelectDropdown
          label="Thread status"
          options={THREAD_STATUS_OPTIONS}
          selected={threadStatus}
          onChange={setThreadStatus}
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
          <button type="button" disabled={bulkPending} onClick={() => runBulk("approve")}>
            Approve selected
          </button>
          <button type="button" disabled={bulkPending} onClick={() => runBulk("spam")}>
            Mark spam selected
          </button>
          <button type="button" disabled={bulkPending} onClick={() => runBulk("delete")}>
            Delete selected
          </button>
          <button type="button" disabled={bulkPending} onClick={() => runBulk("restore")}>
            Restore selected
          </button>
          {bulkError && <span style={{ color: "crimson" }}>{bulkError}</span>}
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
            <th style={sortableTh} onClick={(e) => handleSort("counts", e.ctrlKey)}>
              Commenter activity{sortIndicator("counts")}
            </th>
            <th style={th}>Action</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
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
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted
          rows
        </label>
      </p>
    </>
  );
}
