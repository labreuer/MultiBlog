"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import CommentNode, { hasNonDeletedDescendant, type CommentNodeData } from "./CommentNode";
import QuoteThreadHeader from "./QuoteThreadHeader";
import { useMarginNotesLayout } from "./margin-notes/use-margin-notes-layout";
import { activatePseudoBorderForHash } from "@/lib/pseudo-border";
import type { ThreadStatus } from "@/generated/prisma/enums";
import marginStyles from "./margin-notes/MarginNotes.module.css";

export type CommentEntry = {
  threadId: string;
  quotedText: string;
  anchorFrom: number | null;
  status: ThreadStatus;
  context: string | null;
  color: string;
  root: CommentNodeData;
};

type SortMode = "datetime" | "quoteIndex";

type Props = {
  entries: CommentEntry[];
  postId: string;
};

// Whether an entry could possibly be drawn beside its quote, judged from data
// alone. Used to seed the split before anything has been measured, so the
// first anchored render is already right for the overwhelmingly common case
// rather than flinging half the list across the page a frame later. A
// DETACHED thread is excluded deliberately: its offsets are frozen against
// the revision it was last valid against (PLAN.md §5), so they name a
// position in a document that isn't the one on screen.
function looksAnchored(entry: CommentEntry): boolean {
  return entry.anchorFrom !== null && entry.status === "ACTIVE";
}

export default function CommentEntryList({ entries, postId }: Props) {
  const [sortMode, setSortMode] = useState<SortMode>("datetime");
  const [anchoredIds, setAnchoredIds] = useState<Set<string>>(
    () => new Set(entries.filter(looksAnchored).map((entry) => entry.root.id)),
  );

  // Puts a pseudo-border next to whatever comment the page loaded pointing
  // at (its timestamp permalink hash), and keeps it in sync as the hash
  // changes from clicking other permalinks on the same page.
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

  // A post comment's anchor is a pair of stored integer offsets into the
  // published snapshot (PLAN.md §5) — unlike a doc annotation, whose anchor
  // has to be found in the live document (annotation-marks.ts) — so resolving
  // a card's target is a direct coordsAtPos on `anchorFrom`. `from`, not
  // `to`: the card lines up with where the quoted passage *starts*.
  const resolveTops = useCallback(
    (editor: Editor) => {
      const size = editor.state.doc.content.size;
      const tops = new Map<string, number>();
      for (const entry of sorted) {
        if (!looksAnchored(entry)) continue;
        const pos = Math.max(0, Math.min(entry.anchorFrom!, size));
        try {
          tops.set(entry.root.id, editor.view.coordsAtPos(pos).top);
        } catch {
          // coordsAtPos throws on a position the current document can't
          // resolve. Leaving the id out of the map drops the entry back to
          // the section below, which is where an unplaceable card belongs.
        }
      }
      return tops;
    },
    [sorted],
  );

  // Keyed on the root comment's id, not the thread's: one thread can have
  // several roots (separate people commenting on the same quote without
  // replying to each other), and each renders as its own card.
  const railIds = useMemo(
    () => sorted.filter((entry) => anchoredIds.has(entry.root.id)).map((entry) => entry.root.id),
    [sorted, anchoredIds],
  );

  const { anchored, containerRef, railElement } = useMarginNotesLayout({
    resolveTops,
    ids: railIds,
    onAnchoredIdsChange: setAnchoredIds,
  });

  // Everything stays in one list until there is both room and something to
  // measure against — which is also what a page whose JS never runs gets.
  const inRail = (entry: CommentEntry) => anchored && anchoredIds.has(entry.root.id);
  const belowEntries = sorted.filter((entry) => !inRail(entry));
  const railEntries = sorted.filter(inRail);

  const renderEntry = (entry: CommentEntry) => {
    // A deleted root with no live descendants renders nothing (see
    // CommentNode) — its quoted-text header would otherwise be left
    // dangling above empty space with no comment underneath it.
    const rootRendersNothing =
      entry.root.deletedByUserId !== null && !hasNonDeletedDescendant(entry.root);

    return (
      // data-thread-id (not id) since sorting can scatter a thread's entries
      // apart, and every one of them needs to be reachable — AnnotatableArticle's
      // onIndicatorClick uses querySelectorAll to scroll to and flash all of them.
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
            status={entry.status}
            context={entry.context}
            color={entry.color}
          />
        )}
        <CommentNode comment={entry.root} postId={postId} />
      </div>
    );
  };

  return (
    <>
      <div style={{ margin: "12px 0" }}>
        <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          Sort by:{" "}
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="datetime">Comment date</option>
            <option value="quoteIndex">Quoted text position</option>
          </select>
        </label>
      </div>

      <div className={marginStyles.list}>{belowEntries.map(renderEntry)}</div>

      {/* Anchored cards are drawn in the rail beside the article, but they are
          still *authored* here — this component owns the sort order, the
          permalink/hash effect and the tree rendering, and splitting the list
          across two components would fork all three. A portal moves the DOM
          without moving the ownership. */}
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
