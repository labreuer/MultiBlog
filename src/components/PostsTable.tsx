"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import { useSortableRows } from "@/lib/use-sortable-rows";
import { useShowDeletedRows } from "@/lib/use-show-deleted";
import { deletePost, restorePost } from "@/app/actions/posts";

export type PostRow = {
  id: string;
  slug: string;
  title: string;
  authors: string;
  status: "draft" | "scheduled" | "published";
  publishedAt: Date | null;
  createdAt: Date;
  ahead: number;
  lastEditorName: string;
  lastEditAt: Date | null;
  approved: number;
  pending: number;
  deleted: boolean;
};

function DeleteCell({
  postId,
  deleted,
  onDeleted,
}: {
  postId: string;
  deleted: boolean;
  onDeleted: (postId: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setError(null);
    startTransition(async () => {
      try {
        if (deleted) {
          await restorePost(postId);
        } else {
          await deletePost(postId);
          onDeleted(postId);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update post.");
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={handle}
        disabled={pending}
        aria-label={deleted ? "Restore post" : "Delete post"}
        title={deleted ? "Restore post" : "Delete post"}
        style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: deleted ? "#666" : "#c00" }}
      >
        {deleted ? <IconTrashOff size={16} /> : <IconTrash size={16} />}
      </button>
      {error && <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>}
    </>
  );
}

const DATE_FORMATS = ["yyyy-MM-dd HH:mm", "yyyy-MM-dd", "M/d/yyyy h:mm", "M/d/yyyy"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(date: Date, format: DateFormat): string {
  const yyyy = date.getFullYear();
  const MM = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const M = date.getMonth() + 1;
  const d = date.getDate();
  const HH = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  let h = date.getHours() % 12;
  if (h === 0) h = 12;

  switch (format) {
    case "yyyy-MM-dd HH:mm":
      return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
    case "yyyy-MM-dd":
      return `${yyyy}-${MM}-${dd}`;
    case "M/d/yyyy h:mm":
      return `${M}/${d}/${yyyy} ${h}:${mm}`;
    case "M/d/yyyy":
      return `${M}/${d}/${yyyy}`;
  }
}

type SortKey = "title" | "authors" | "published" | "comments" | "ahead" | "editor" | "lastEdit" | "created";

function compareNullableDates(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

// Nulls always sort last, in either direction — the caller negates this
// return value for "desc", so the null-vs-non-null part has to pre-flip
// (via `dir`) to counteract that negation and stay anchored at the bottom;
// only the non-null-vs-non-null date comparison is left for the caller's
// flip to actually reverse.
function compareNullableDatesAlwaysLast(a: Date | null, b: Date | null, dir: "asc" | "desc"): number {
  if (a === null && b === null) return 0;
  const sign = dir === "asc" ? 1 : -1;
  if (a === null) return sign;
  if (b === null) return -sign;
  return a.getTime() - b.getTime();
}

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };
const sortableTh: React.CSSProperties = { ...th, cursor: "pointer", userSelect: "none" };
// Prevents a date string's hyphens, or a space in a multi-word value/header
// (e.g. "Created at", a person's full name), from being treated as a
// line-break opportunity in a narrow column.
const nowrapTd: React.CSSProperties = { ...td, whiteSpace: "nowrap" };
const nowrapSortableTh: React.CSSProperties = { ...sortableTh, whiteSpace: "nowrap" };

function compareByKey(key: SortKey, a: PostRow, b: PostRow, dir: "asc" | "desc"): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title);
    case "authors":
      return a.authors.localeCompare(b.authors);
    case "published":
      // publishedAt holds a future date for a scheduled row and a past one
      // for a published row (there is no separate scheduledFor anymore), so
      // this single comparison already sorts both correctly.
      return compareNullableDatesAlwaysLast(a.publishedAt, b.publishedAt, dir);
    case "ahead":
      return a.ahead - b.ahead;
    case "editor":
      return a.lastEditorName.localeCompare(b.lastEditorName);
    case "lastEdit":
      return compareNullableDates(a.lastEditAt, b.lastEditAt);
    case "comments":
      return a.approved - b.approved;
    case "created":
      return a.createdAt.getTime() - b.createdAt.getTime();
  }
}

export default function PostsTable({ rows }: { rows: PostRow[] }) {
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [searchText, setSearchText] = useState("");
  const [titleWidth, setTitleWidth] = useState<number | null>(null);
  const titleThRef = useRef<HTMLTableCellElement>(null);
  const { showDeleted, toggle: toggleShowDeleted } = useShowDeletedRows("posts-show-deleted-rows");
  // Ids of rows deleted during this visit, kept visible independent of the
  // showDeleted toggle — deleting one row shouldn't suddenly surface every
  // *other* already-deleted row that showDeleted is intentionally hiding.
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  function revealRow(id: string) {
    setRevealedIds((prev) => new Set(prev).add(id));
  }

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

  const filteredRows = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (showDeleted || !row.deleted || revealedIds.has(row.id)) &&
        (!needle || row.title.toLowerCase().includes(needle)),
    );
  }, [rows, searchText, showDeleted, revealedIds]);

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

  if (rows.length === 0) {
    return <p>No posts yet.</p>;
  }

  return (
    <>
      <input
        type="search"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder="Search title …"
        aria-label="Search title"
        style={{
          display: "block",
          width: titleWidth ?? undefined,
          padding: "6px 12px",
          marginTop: "1em",
          marginBottom: 8,
          marginLeft: 0,
        }}
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th ref={titleThRef} style={sortableTh} onClick={(e) => handleSort("title", e.ctrlKey)}>
              Title{sortIndicator("title")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("authors", e.ctrlKey)}>
              Author(s){sortIndicator("authors")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("published", e.ctrlKey)}>
              Published{sortIndicator("published")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("comments", e.ctrlKey)}>
              Comments{sortIndicator("comments")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("ahead", e.ctrlKey)}>
              Revisions{sortIndicator("ahead")}
            </th>
            <th style={nowrapSortableTh} onClick={(e) => handleSort("editor", e.ctrlKey)}>
              Last edit by{sortIndicator("editor")}
            </th>
            <th style={nowrapSortableTh} onClick={(e) => handleSort("lastEdit", e.ctrlKey)}>
              Last edit at{sortIndicator("lastEdit")}
            </th>
            <th style={nowrapSortableTh} onClick={(e) => handleSort("created", e.ctrlKey)}>
              Created at{sortIndicator("created")}
            </th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.id} style={{ borderBottom: "1px solid #eee", opacity: row.deleted ? 0.5 : 1 }}>
              <td style={td}>
                <Link href={`/posts/${row.id}/edit`}>{row.title}</Link>
              </td>
              <td style={td}>{row.authors}</td>
              <td style={nowrapTd}>
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
              <td style={td}>
                {row.approved}
                {row.pending > 0 && (
                  <>
                    {" "}
                    <Link href={`/posts/${row.id}/comments`}>(in moderation {row.pending})</Link>
                  </>
                )}
              </td>
              <td style={td}>
                <Link href={`/posts/${row.id}/history`}>{row.ahead === 0 ? "current" : `+${row.ahead}`}</Link>
              </td>
              <td style={nowrapTd}>{row.lastEditorName}</td>
              <td style={nowrapTd}>{row.lastEditAt ? formatDate(row.lastEditAt, dateFormat) : ""}</td>
              <td style={nowrapTd}>{formatDate(row.createdAt, dateFormat)}</td>
              <td style={td}>
                <DeleteCell postId={row.id} deleted={row.deleted} onDeleted={revealRow} />
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
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => toggleShowDeleted(e.target.checked)}
          />{" "}
          Show deleted rows
        </label>
      </p>
    </>
  );
}
