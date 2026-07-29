"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconTrash, IconTrashOff } from "@tabler/icons-react";
import { useSortableRows } from "@/lib/use-sortable-rows";
import { useShowDeletedRows } from "@/lib/use-show-deleted";
import { deleteDoc, restoreDoc } from "@/app/actions/docs";
import { formatDate } from "@/lib/format-date";
import type { DocVisibility } from "@/generated/prisma/enums";

export type DocRow = {
  id: string;
  slug: string;
  title: string;
  authors: string;
  visibility: DocVisibility;
  createdAt: Date;
  deleted: boolean;
};

type SortKey = "title" | "authors" | "visibility" | "created" | "deleted";

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };
const sortableTh: React.CSSProperties = { ...th, cursor: "pointer", userSelect: "none" };
const nowrapTd: React.CSSProperties = { ...td, whiteSpace: "nowrap" };
const nowrapSortableTh: React.CSSProperties = { ...sortableTh, whiteSpace: "nowrap" };

function compareByKey(key: SortKey, a: DocRow, b: DocRow): number {
  switch (key) {
    case "title":
      return a.title.localeCompare(b.title);
    case "authors":
      return a.authors.localeCompare(b.authors);
    case "visibility":
      return a.visibility.localeCompare(b.visibility);
    case "created":
      return a.createdAt.getTime() - b.createdAt.getTime();
    case "deleted":
      return a.deleted === b.deleted ? 0 : a.deleted ? 1 : -1;
  }
}

function DeleteCell({ docId, deleted, onDeleted }: { docId: string; deleted: boolean; onDeleted: (docId: string) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setError(null);
    startTransition(async () => {
      try {
        if (deleted) {
          await restoreDoc(docId);
        } else {
          await deleteDoc(docId);
          onDeleted(docId);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update doc.");
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={handle}
        disabled={pending}
        aria-label={deleted ? "Restore doc" : "Delete doc"}
        title={deleted ? "Restore doc" : "Delete doc"}
        style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: deleted ? "#666" : "#c00" }}
      >
        {deleted ? <IconTrashOff size={16} /> : <IconTrash size={16} />}
      </button>
      {error && <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>}
    </>
  );
}

export default function DocsTable({ rows }: { rows: DocRow[] }) {
  const [searchText, setSearchText] = useState("");
  const { showDeleted, toggle: toggleShowDeleted } = useShowDeletedRows("docs-show-deleted-rows");
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  function revealRow(id: string) {
    setRevealedIds((prev) => new Set(prev).add(id));
  }

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
    return <p>No docs yet.</p>;
  }

  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: "1em", marginBottom: 8 }}>
        <input
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search title …"
          aria-label="Search title"
          style={{ padding: "6px 12px" }}
        />
        <label style={{ fontSize: "0.85rem", color: "#444" }}>
          <input type="checkbox" checked={showDeleted} onChange={(e) => toggleShowDeleted(e.target.checked)} /> Show deleted
        </label>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th style={sortableTh} onClick={(e) => handleSort("title", e.ctrlKey)}>
              Title{sortIndicator("title")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("authors", e.ctrlKey)}>
              Author(s){sortIndicator("authors")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("visibility", e.ctrlKey)}>
              Visibility{sortIndicator("visibility")}
            </th>
            <th style={nowrapSortableTh} onClick={(e) => handleSort("created", e.ctrlKey)}>
              Created{sortIndicator("created")}
            </th>
            <th style={sortableTh} onClick={(e) => handleSort("deleted", e.ctrlKey)}>
              {sortIndicator("deleted")}
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.id} style={{ opacity: row.deleted ? 0.6 : 1 }}>
              <td style={td}>
                <Link href={`/doc/${row.id}/edit`}>{row.title}</Link>
              </td>
              <td style={td}>{row.authors}</td>
              <td style={td}>{row.visibility}</td>
              <td style={nowrapTd}>{formatDate(row.createdAt, "yyyy-MM-dd HH:mm")}</td>
              <td style={td}>
                <DeleteCell
                  docId={row.id}
                  deleted={row.deleted}
                  onDeleted={(id) => {
                    revealRow(id);
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
