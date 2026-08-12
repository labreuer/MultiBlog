"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import AnnotationNode, { hasNonDeletedDescendant, type AnnotationNodeData } from "./AnnotationNode";
import QuoteThreadHeader from "../QuoteThreadHeader";
import { useMarginNotesLayout } from "../margin-notes/use-margin-notes-layout";
import { collectAnnotationMarkRanges } from "@/lib/annotation-marks";
import { activatePseudoBorderForHash } from "@/lib/pseudo-border";
import marginStyles from "../margin-notes/MarginNotes.module.css";

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

  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        if (sortMode === "quoteIndex") {
          const aIndex = a.anchorFrom ?? Infinity;
          const bIndex = b.anchorFrom ?? Infinity;
          if (aIndex !== bIndex) return aIndex - bIndex;
        }
        return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
      }),
    [entries, sortMode],
  );

  // Where CommentEntryList reads a stored offset, this has to *find* the
  // anchor: a doc annotation's anchor is a mark inside the doc's own ydoc
  // (PLAN.md §12i), which is why `entry.anchorFrom` is null for every one of
  // these. Scanning the live editor rather than trusting the server's
  // `quotedText` also means the card follows the text as an author edits
  // above it, instead of pointing where the last store debounce saw it.
  //
  // A thread whose mark is gone (§12h — degraded to document-level) simply
  // isn't in the map, and lands at the end of the rail with the
  // general-discussion threads, which is where it already sorted.
  const resolveTops = useCallback(
    (editor: Editor) => {
      const ranges = collectAnnotationMarkRanges(editor.state.doc);
      const tops = new Map<string, number>();
      for (const entry of sorted) {
        const range = ranges.get(entry.threadId);
        if (!range) continue;
        try {
          tops.set(entry.root.id, editor.view.coordsAtPos(range.from).top);
        } catch {
          // A position the current document can't resolve; treated as
          // anchorless, same as a missing mark.
        }
      }
      return tops;
    },
    [sorted],
  );

  const ids = useMemo(() => sorted.map((entry) => entry.root.id), [sorted]);
  const { anchored, containerRef } = useMarginNotesLayout({ resolveTops, ids });

  return (
    <>
      {/* Kept in both layouts — see CommentEntryList's note on why an inert
          control beats a disappearing one. */}
      <div style={{ margin: "12px 0" }}>
        <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          Sort by:{" "}
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="datetime">Annotation date</option>
            <option value="quoteIndex">Quoted text position</option>
          </select>
        </label>
      </div>

      <div ref={containerRef} className={`${marginStyles.list} ${anchored ? marginStyles.anchored : ""}`}>
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
              data-margin-note-id={entry.root.id}
              className={marginStyles.entry}
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
      </div>
    </>
  );
}
