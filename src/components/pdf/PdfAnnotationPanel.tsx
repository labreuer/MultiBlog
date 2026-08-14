"use client";

import { useCallback, useMemo, useState } from "react";
import AnnotationNode, { hasNonDeletedDescendant, type AnnotationNodeData } from "@/components/annotation/AnnotationNode";
import QuoteThreadHeader from "@/components/QuoteThreadHeader";
import NewAnnotationComposer from "@/components/annotation/NewAnnotationComposer";
import { usePdfMarginNotes } from "./use-pdf-margin-notes";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { quadsTopY } from "@/lib/pdf-anchor";
import styles from "./PdfAnnotations.module.css";

// PLAN.md §19 Phase 3 — the annotation column beside the PDF.
//
// The full-viewport shell means this is *both* halves of what /doc/[slug]
// splits: the section (heading, composer, every entry) and the rail (cards
// level with their passage) are the same scroller here, so there is no
// `createPortal`. That is the one simplification the app-shell layout buys over
// PLAN.md §18's arrangement, and it is why this doesn't reuse AnnotationList.
//
// The other difference is which cards can be positioned at all. On a doc, every
// anchored card has a live position because the whole document is in the DOM.
// pdfjs renders a handful of pages, so most annotations have *no* on-screen
// anchor at any moment — they aren't detached, just off-screen. They cascade to
// the end of the panel greyed, and the set changes as the reader scrolls.

export type PdfAnnotationEntry = {
  threadId: string;
  quotedText: string;
  color: string;
  target: PdfTarget | null;
  root: AnnotationNodeData;
};

type SortMode = "datetime" | "position";

type Props = {
  fileId: string;
  entries: PdfAnnotationEntry[];
  /** Viewport-space top edge per annotation id, for the ones on a rendered page. */
  resolveTops: () => Map<string, number>;
  /** Subscribe to "the rendering moved" — the viewer's scroll/render/scale events. */
  subscribe: (listener: () => void) => () => void;
  /** Whether to position cards. False below the breakpoint, where this is a plain list. */
  positioned: boolean;
  /** Scroll the viewer to an annotation. */
  onJumpTo: (entry: PdfAnnotationEntry) => void;
  /** A selection captured in the viewer, waiting to become an annotation. */
  pendingTarget: PdfTarget | null;
  /** Changes on every capture, so the composer remounts even for an identical re-selection. */
  pendingKey: number;
};

export default function PdfAnnotationPanel({
  fileId,
  entries,
  resolveTops,
  subscribe,
  positioned,
  onJumpTo,
  pendingTarget,
  pendingKey,
}: Props) {
  const [sortMode, setSortMode] = useState<SortMode>("position");

  // Position order is (page, then down the page). `quadsTopY` returns PDF user
  // space, where y increases *upward*, so a larger y is higher on the page and
  // therefore earlier — hence the reversed comparison. Getting this backwards
  // is the kind of thing that looks fine on a one-page document.
  const sorted = useMemo(() => {
    const withOrder = entries.map((entry) => ({
      entry,
      page: entry.target?.pageIndex ?? Number.POSITIVE_INFINITY,
      y: entry.target ? -(quadsTopY(entry.target.quads) ?? 0) : Number.POSITIVE_INFINITY,
      time: new Date(entry.root.createdAt).getTime(),
    }));
    withOrder.sort((a, b) => {
      if (sortMode === "position") {
        if (a.page !== b.page) return a.page - b.page;
        if (a.y !== b.y) return a.y - b.y;
      }
      return a.time - b.time;
    });
    return withOrder.map((w) => w.entry);
  }, [entries, sortMode]);

  const ids = useMemo(() => sorted.map((entry) => entry.root.id), [sorted]);
  const { containerRef, isAnchored } = usePdfMarginNotes({
    resolveTops,
    ids,
    subscribe,
    enabled: positioned,
  });

  const renderEntry = useCallback(
    (entry: PdfAnnotationEntry) => {
      // A deleted root with no live descendants renders nothing (see
      // AnnotationNode) — its quote header would otherwise dangle above empty
      // space, the same rule AnnotationList applies.
      const rootRendersNothing = entry.root.deletedByUserId !== null && !hasNonDeletedDescendant(entry.root);
      const offscreen = positioned && !isAnchored(entry.root.id);

      return (
        <div
          key={entry.root.id}
          data-margin-note-id={entry.root.id}
          data-thread-id={entry.threadId}
          className={`${styles.card} ${offscreen ? styles.offscreen : ""}`}
        >
          {entry.target && (
            <button
              type="button"
              className={styles.pageBadge}
              onClick={() => onJumpTo(entry)}
              title="Jump to this passage"
            >
              p. {entry.target.pageIndex + 1}
            </button>
          )}
          {entry.quotedText && !rootRendersNothing && (
            <QuoteThreadHeader
              threadId={entry.threadId}
              quotedText={entry.quotedText}
              status="ACTIVE"
              context={null}
              color={entry.color}
            />
          )}
          <AnnotationNode annotation={entry.root} target={{ kind: "file", id: fileId }} />
        </div>
      );
    },
    [fileId, isAnchored, onJumpTo, positioned],
  );

  return (
    <div className={styles.panelInner}>
      <h2 className={styles.heading}>Annotations</h2>

      {/* Remounted whenever a new selection arrives, so the composer opens a
          fresh draft against the new target rather than reusing an open one
          pointing at the previous selection. */}
      <NewAnnotationComposer
        key={pendingTarget ? `pending-${pendingKey}` : "idle"}
        target={{ kind: "file", id: fileId }}
        pdfTarget={pendingTarget ?? undefined}
      />

      {entries.length === 0 ? (
        <p className={styles.empty}>No annotations yet. Select text in the document to add one.</p>
      ) : (
        <>
          <div className={styles.sortRow}>
            <label>
              Sort by:{" "}
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                <option value="position">Position in document</option>
                <option value="datetime">Annotation date</option>
              </select>
            </label>
          </div>

          <div ref={containerRef} className={styles.cards} data-pseudo-border-root>
            {sorted.map(renderEntry)}
          </div>
        </>
      )}
    </div>
  );
}
