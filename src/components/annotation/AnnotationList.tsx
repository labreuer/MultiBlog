"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import AnnotationNode, { hasNonDeletedDescendant, type AnnotationNodeData } from "./AnnotationNode";
import QuoteThreadHeader from "../QuoteThreadHeader";
import { useMarginNotesLayout } from "../margin-notes/use-margin-notes-layout";
import { resolveAnnotationRanges } from "@/lib/annotation-marks";
import { activatePseudoBorderForHash } from "@/lib/pseudo-border";
import marginStyles from "../margin-notes/MarginNotes.module.css";

export type AnnotationEntry = {
  threadId: string;
  quotedText: string;
  // PLAN.md §13o — non-null exactly for a thread anchored from a reading
  // view; a mark-anchored one carries no stored offset and is found in the
  // live document instead. Both pages turn the non-null ones into the
  // editor's `AnnotationAnchorInput` list.
  anchorFrom: number | null;
  anchorTo: number | null;
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
  // Seeded from the server's snapshot answer — `quotedText` is non-empty
  // exactly when `Doc.proseJson` still carried the mark at the last store
  // debounce — then corrected by the live scan below. Seeding rather than
  // starting empty keeps the first anchored render right for the common case;
  // trusting it beyond that is what §18b says not to do.
  const [anchoredIds, setAnchoredIds] = useState<Set<string>>(
    () => new Set(entries.filter((entry) => entry.quotedText !== "").map((entry) => entry.root.id)),
  );

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

  // Where CommentEntryList reads a stored offset straight off its props, this
  // asks the live editor — through `resolveAnnotationRanges`, which answers
  // for both mechanisms at once (PLAN.md §13o): a mark read off the document,
  // or a stored offset the highlight plugin has been tracking per
  // transaction. Even the stored ones are re-resolved rather than used as
  // given, since a doc has no immutable snapshot to make them stable —
  // §18b's point about not positioning against a store-debounce snapshot
  // applies to a column just as much as it did to `quotedText`.
  //
  // A thread whose anchor doesn't resolve (§12h's lost mark; a stored quote
  // whose text is gone) simply isn't in the map, which drops it out of the
  // rail and back into the list below — where, unlike a lost mark, a stored
  // quote still has a blockquote to show.
  const resolveTops = useCallback(
    (editor: Editor) => {
      const ranges = resolveAnnotationRanges(editor.state);
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

  const railIds = useMemo(
    () => sorted.filter((entry) => anchoredIds.has(entry.root.id)).map((entry) => entry.root.id),
    [sorted, anchoredIds],
  );

  const { anchored, containerRef, railElement } = useMarginNotesLayout({
    resolveTops,
    ids: railIds,
    onAnchoredIdsChange: setAnchoredIds,
  });

  const inRail = (entry: AnnotationEntry) => anchored && anchoredIds.has(entry.root.id);
  const belowEntries = sorted.filter((entry) => !inRail(entry));
  const railEntries = sorted.filter(inRail);

  const renderEntry = (entry: AnnotationEntry) => {
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
        <AnnotationNode annotation={entry.root} target={{ kind: "doc", id: docId }} />
      </div>
    );
  };

  return (
    <>
      <div style={{ margin: "12px 0" }}>
        <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          Sort by:{" "}
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="datetime">Annotation date</option>
            <option value="quoteIndex">Quoted text position</option>
          </select>
        </label>
      </div>

      <div className={marginStyles.list}>{belowEntries.map(renderEntry)}</div>

      {/* See CommentEntryList's note: the cards move, the ownership doesn't. */}
      {anchored &&
        railElement &&
        createPortal(
          <div
            ref={containerRef}
            data-pseudo-border-root
            className={`${marginStyles.list} ${marginStyles.anchored}`}
          >
            {railEntries.map(renderEntry)}
          </div>,
          railElement,
        )}
    </>
  );
}
