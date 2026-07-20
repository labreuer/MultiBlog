"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export type PostRow = {
  id: string;
  slug: string;
  title: string;
  isPublished: boolean;
  publishedAt: Date | null;
  createdAt: Date;
  ahead: number;
  lastEditorName: string;
  lastEditAt: Date | null;
  approved: number;
  pending: number;
};

const DATE_FORMATS = ["yyyy-MM-dd HH:mm", "yyyy-MM-dd", "M/d/yyyy h:mm", "M/d/yyyy"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

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

type SortKey = "title" | "published" | "comments" | "ahead" | "editor" | "lastEdit" | "created";

function compareNullableDates(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };
const sortableTh: React.CSSProperties = { ...th, cursor: "pointer", userSelect: "none" };

type SortColumn = { key: SortKey; dir: "asc" | "desc" };

function compareByKey(key: SortKey, a: PostRow, b: PostRow): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title);
    case "published":
      return compareNullableDates(a.publishedAt, b.publishedAt);
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
  const [sortColumns, setSortColumns] = useState<SortColumn[]>([]);

  function handleSort(key: SortKey, addToSort: boolean) {
    setSortColumns((prev) => {
      const idx = prev.findIndex((c) => c.key === key);
      if (addToSort) {
        if (idx === -1) {
          return [...prev, { key, dir: "asc" }];
        }
        const next = [...prev];
        next[idx] = { key, dir: next[idx].dir === "asc" ? "desc" : "asc" };
        return next;
      }
      if (prev.length === 1 && idx === 0) {
        return [{ key, dir: prev[0].dir === "asc" ? "desc" : "asc" }];
      }
      return [{ key, dir: "asc" }];
    });
  }

  function sortIndicator(key: SortKey) {
    const idx = sortColumns.findIndex((c) => c.key === key);
    if (idx === -1) return null;
    return (
      <>
        {" "}
        {sortColumns[idx].dir === "asc" ? "▲" : "▼"}
        {idx > 0 && <sup>{idx + 1}</sup>}
      </>
    );
  }

  const sortedRows = useMemo(() => {
    if (sortColumns.length === 0) return rows;
    const sorted = [...rows].sort((a, b) => {
      for (const { key, dir } of sortColumns) {
        const cmp = compareByKey(key, a, b);
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return sorted;
  }, [rows, sortColumns]);

  if (rows.length === 0) {
    return <p>No posts yet.</p>;
  }

  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th style={sortableTh} onClick={(e) => handleSort("title", e.ctrlKey)}>
              Title{sortIndicator("title")}
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
            <th style={sortableTh} onClick={(e) => handleSort("editor", e.ctrlKey)}>
              Last edit by{sortIndicator("editor")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("lastEdit", e.ctrlKey)}>
              Last edit at{sortIndicator("lastEdit")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("created", e.ctrlKey)}>
              Created at{sortIndicator("created")}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>
                <Link href={`/posts/${row.id}/edit`}>{row.title}</Link>
              </td>
              <td style={td}>
                {row.isPublished && row.publishedAt ? (
                  <Link href={`/${row.slug}`}>{formatDate(row.publishedAt, dateFormat)}</Link>
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
              <td style={td}>{row.lastEditorName}</td>
              <td style={td}>{row.lastEditAt ? formatDate(row.lastEditAt, dateFormat) : ""}</td>
              <td style={td}>{formatDate(row.createdAt, dateFormat)}</td>
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
    </>
  );
}
