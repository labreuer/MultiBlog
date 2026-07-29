"use client";

import { useEffect, useState } from "react";
import AnnotationNode, { hasNonDeletedDescendant, type AnnotationNodeData } from "./AnnotationNode";
import QuoteThreadHeader from "../QuoteThreadHeader";
import { activatePseudoBorderForHash } from "@/lib/pseudo-border";

export type AnnotationEntry = {
  threadId: string;
  quotedText: string;
  anchorFrom: number | null;
  color: string;
  root: AnnotationNodeData;
};

type SortMode = "datetime" | "quoteIndex";

type Props = {
  entries: AnnotationEntry[];
  docId: string;
};

// The doc-side sibling of CommentEntryList (PLAN.md §13c). QuoteThreadHeader
// and pseudo-border.ts stay shared, unlike the rest of the Comment* tree —
// neither was ever coupled to CommentTarget (§12i/§12n), so there's nothing
// to un-share.
export default function AnnotationList({ entries, docId }: Props) {
  const [sortMode, setSortMode] = useState<SortMode>("datetime");

  // Puts a pseudo-border next to whatever annotation the page loaded
  // pointing at (its timestamp permalink hash), and keeps it in sync as the
  // hash changes from clicking other permalinks on the same page.
  useEffect(() => {
    activatePseudoBorderForHash(window.location.hash.slice(1));
    const onHashChange = () => activatePseudoBorderForHash(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const sorted = [...entries].sort((a, b) => {
    if (sortMode === "quoteIndex") {
      const aIndex = a.anchorFrom ?? Infinity;
      const bIndex = b.anchorFrom ?? Infinity;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return (
    <>
      <div style={{ margin: "12px 0" }}>
        <label style={{ fontSize: "0.85rem", color: "#555" }}>
          Sort by:{" "}
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="datetime">Annotation date</option>
            <option value="quoteIndex">Quoted text position</option>
          </select>
        </label>
      </div>

      {sorted.map((entry) => {
        // A deleted root with no live descendants renders nothing (see
        // AnnotationNode) — its quoted-text header would otherwise be left
        // dangling above empty space with no annotation underneath it.
        const rootRendersNothing =
          entry.root.deletedByUserId !== null && !hasNonDeletedDescendant(entry.root);

        return (
          <div
            key={entry.root.id}
            data-thread-id={entry.threadId}
            data-thread-color={entry.color}
            style={{ marginTop: 24 }}
          >
            {entry.quotedText && !rootRendersNothing && (
              <QuoteThreadHeader
                threadId={entry.threadId}
                quotedText={entry.quotedText}
                status="ACTIVE"
                context={null}
                color={entry.color}
              />
            )}
            <AnnotationNode annotation={entry.root} docId={docId} />
          </div>
        );
      })}
    </>
  );
}
