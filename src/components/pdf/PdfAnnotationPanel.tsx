"use client";

import { useCallback, useMemo, useState } from "react";
import AnnotationNode, { hasNonDeletedDescendant, type AnnotationNodeData } from "@/components/annotation/AnnotationNode";
import QuoteThreadHeader from "@/components/QuoteThreadHeader";
import NewAnnotationComposer from "@/components/annotation/NewAnnotationComposer";
import { usePdfMarginNotes } from "./use-pdf-margin-notes";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { quadsTopY } from "@/lib/pdf-anchor";
import { JUMP_VIEWPORT_FRACTION } from "@/lib/pdf-geometry";
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
// pdfjs shows a few pages of a long PDF, so most annotations have *no* on-screen
// anchor at any moment — they aren't detached, just out of view.
//
// **The rail holds only those, and is therefore never taller than the panel.**
// Two modes, and the toggle between them is the whole design:
//
//   Rail  cards for passages currently on screen, each level with its own
//         passage. Everything else is hidden — not greyed and cascaded to the
//         end, which is what used to make this column arbitrarily tall: an
//         annotation four pages down was placed four pages down, in a container
//         grown to fit it, so it sat far below the fold with nothing to align
//         with anyway. It scrolls only when more annotations are anchored on
//         screen than fit beside them.
//   All   every annotation as a plain list, in document order, positioned by
//         nothing. This is where an annotation you haven't scrolled to lives,
//         and the only place a document-level one (no target at all) appears.
//
// Hidden means `display: none`, not unmounted, and that is load-bearing: a card
// can be holding an open reply composer — a live Hocuspocus connection and a
// DRAFT row — or a delete confirmation, and scrolling the passage off screen
// must not throw that away. It also keeps the ids the layout hook is keyed on
// stable, so membership changes don't tear down its observers on every scroll.

export type PdfAnnotationEntry = {
  threadId: string;
  quotedText: string;
  color: string;
  target: PdfTarget | null;
  root: AnnotationNodeData;
};

/**
 * Whether a thread still has anything to show.
 *
 * Deletion is a *soft* delete, and a deleted root whose replies survive is
 * still a live conversation — so this is `hasNonDeletedDescendant`, not a plain
 * `deletedByUserId === null`. Exported because **four** surfaces have to agree
 * on it: the card, its page badge, the highlight drawn on the page, and the
 * tick on the right-hand strip. They did not, and the result was that deleting
 * an annotation removed its card while leaving its highlight, its tick and a
 * stray page badge behind — "I deleted it but it's still there".
 *
 * The doc side gets this for free: it has no highlight of its own to clean up
 * (a mark is content, so it goes when the mark does) and no rail ticks, so
 * AnnotationNode rendering nothing is the whole story there.
 */
export function entryHasVisibleContent(entry: PdfAnnotationEntry): boolean {
  return entry.root.deletedByUserId === null || hasNonDeletedDescendant(entry.root);
}

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
  /**
   * Scroll the document to this entry's passage. The second argument is how far
   * down the viewport to land it (`JUMP_VIEWPORT_FRACTION` or 0) — the panel's
   * call, because only the panel knows whether its own chrome is currently
   * overlaying the card the reader is about to look for.
   */
  onJumpTo: (entry: PdfAnnotationEntry, viewportFraction: number) => void;
  /** A selection captured in the viewer, waiting to become an annotation. */
  pendingTarget: PdfTarget | null;
  /** Changes on every capture, so the composer remounts even for an identical re-selection. */
  pendingKey: number;
  /** Drop the captured selection — the composer was cancelled, or the reader changed their mind. */
  onClearPending: () => void;
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
  onClearPending,
}: Props) {
  // Position order is (page, then down the page), with creation time breaking
  // ties — for the unanchored entries, which share one page/y sentinel, that is
  // the whole order. `quadsTopY` returns PDF user space, where y increases
  // *upward*, so a larger y is higher on the page and therefore earlier — hence
  // the reversed comparison. Getting this backwards is the kind of thing that
  // looks fine on a one-page document.
  //
  // Not a choice the reader makes: this panel is the margin-note rail above the
  // breakpoint, where a card sits level with its own passage, so any order but
  // position would fight the positioning hook rather than re-sort the list.
  const sorted = useMemo(() => {
    // Fully-deleted threads drop out here rather than rendering an empty
    // shell — see entryHasVisibleContent. Doing it at the top means the
    // layout hook never measures them either.
    const withOrder = entries.filter(entryHasVisibleContent).map((entry) => ({
      entry,
      page: entry.target?.pageIndex ?? Number.POSITIVE_INFINITY,
      y: entry.target ? -(quadsTopY(entry.target.quads) ?? 0) : Number.POSITIVE_INFINITY,
      time: new Date(entry.root.createdAt).getTime(),
    }));
    withOrder.sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (a.y !== b.y) return a.y - b.y;
      return a.time - b.time;
    });
    return withOrder.map((w) => w.entry);
  }, [entries]);

  // Rail unless the reader asks for the list — and never below the breakpoint,
  // where nothing is positioned and the panel is a full-width overlay with no
  // document beside it to align to.
  const [showAll, setShowAll] = useState(false);
  const railMode = positioned && !showAll;

  const ids = useMemo(() => sorted.map((entry) => entry.root.id), [sorted]);
  const { containerRef, isAnchored } = usePdfMarginNotes({
    resolveTops,
    ids,
    subscribe,
    enabled: railMode,
  });

  const railCount = useMemo(
    () => (railMode ? sorted.filter((entry) => isAnchored(entry.root.id)).length : sorted.length),
    [railMode, sorted, isAnchored],
  );

  const renderEntry = useCallback(
    (entry: PdfAnnotationEntry) => {
      const hidden = railMode && !isAnchored(entry.root.id);

      return (
        <div
          key={entry.root.id}
          data-margin-note-id={entry.root.id}
          data-thread-id={entry.threadId}
          className={`${styles.card} ${hidden ? styles.notInRail : ""}`}
        >
          {entry.target && (
            <button
              type="button"
              className={styles.pageBadge}
              // Rail mode puts the card level with its passage and the chrome
              // over the top of the rail, so a passage landing flush against
              // the top edge takes its own card under the heading with it. In
              // "Show all" the card is a list item that does not move, so the
              // document goes where it was asked to.
              onClick={() => onJumpTo(entry, railMode ? JUMP_VIEWPORT_FRACTION : 0)}
              title="Jump to this passage"
              // The visible text is just "p. 4", which tells a screen reader
              // nothing about what the control does; `title` is only used as an
              // accessible name when an element has no content, so it doesn't
              // fill the gap here.
              aria-label={`Jump to this passage on page ${entry.target.pageIndex + 1}`}
            >
              p. {entry.target.pageIndex + 1}
            </button>
          )}
          {entry.quotedText && (
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
    [fileId, isAnchored, onJumpTo, railMode],
  );

  // The panel's own chrome, grouped so rail mode can lift it out of the flow
  // and float it over the cards (see `.stack`). Everything here is fixed at the
  // top of the panel; everything below scrolls past underneath it.
  const chrome = (
    <div className={styles.chrome}>
      <h2 className={styles.heading}>Annotations</h2>

      {/* What the reader just selected, shown *before* the editor so that
          clicking "Annotate" over the document has a visible result here —
          otherwise the capture succeeds silently and the panel looks unchanged.
          It is also the only place the anchor is legible before posting: the
          server derives the stored quote itself, so this is the client's own
          reading, shown for confirmation rather than as the record. */}
      {pendingTarget && (
        <div className={styles.pendingQuote}>
          <span className={styles.pendingLabel}>
            Annotating page {pendingTarget.pageIndex + 1}
            {pendingTarget.quote.exact ? "" : " (region)"}
          </span>
          {pendingTarget.quote.exact && <blockquote>{pendingTarget.quote.exact}</blockquote>}
          <button type="button" className={styles.pendingClear} onClick={onClearPending}>
            Clear selection
          </button>
        </div>
      )}

      {/* Remounted whenever a new selection arrives, so the composer opens a
          fresh draft against the new target rather than reusing an open one
          pointing at the previous selection. `autoOpen` follows from the same
          fact: the gesture that starts this composer happened over the
          document, not here. */}
      <NewAnnotationComposer
        key={pendingTarget ? `pending-${pendingKey}` : "idle"}
        target={{ kind: "file", id: fileId }}
        pdfTarget={pendingTarget ?? undefined}
        autoOpen={pendingTarget !== null}
        onSettled={onClearPending}
      />

      {sorted.length === 0 && (
        <p className={styles.empty}>No annotations yet. Select text in the document to add one.</p>
      )}

      {/* Only above the breakpoint: below it nothing is positioned, so the
          list is all there is and a toggle would offer the state it's
          already in. */}
      {sorted.length > 0 && positioned && (
        <div className={styles.modeRow}>
          <button
            type="button"
            className={styles.modeToggle}
            onClick={() => setShowAll((previous) => !previous)}
            aria-pressed={showAll}
          >
            {showAll ? "Show beside the text" : `Show all ${sorted.length}`}
          </button>
        </div>
      )}

      {/* Empty in rail mode is a normal state, not an error — it means the
          reader is looking at part of the document nobody has annotated —
          so it says which part is missing rather than "no annotations". The
          container still renders beneath it: the cards are in it, hidden,
          and the hook needs them measurable the moment one comes into view. */}
      {sorted.length > 0 && railMode && railCount === 0 && (
        <p className={styles.empty}>
          Nothing annotated on screen.{" "}
          {/* Worded differently from the toggle above deliberately: two
              controls with the same accessible name in one panel is a
              locator ambiguity for anything driving it, screen readers
              included. */}
          <button type="button" className={styles.emptyLink} onClick={() => setShowAll(true)}>
            Show them all
          </button>
          .
        </p>
      )}
    </div>
  );

  return (
    <div className={styles.panelInner}>
      {/* In rail mode the chrome and the cards share one grid cell, so a card's
          coordinate origin is the top of the panel rather than the bottom of
          the chrome. That is what lets a card be positioned level with a
          passage near the top of the viewer at all — before, everything in the
          panel's first ~150px was clamped to the chrome's underside — and it is
          what makes a card entering from above slide out from under the chrome
          instead of appearing at full height in one frame. The chrome is opaque
          and paints over them on the way past, deliberately. */}
      <div className={railMode ? styles.stack : undefined}>
        {chrome}

        {sorted.length > 0 && (
          <div ref={containerRef} className={styles.cards} data-pseudo-border-root>
            {sorted.map(renderEntry)}
          </div>
        )}
      </div>
    </div>
  );
}
