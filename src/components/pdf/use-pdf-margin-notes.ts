"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { packMarginNotes, type MarginNoteMeasurement } from "@/lib/margin-notes-layout";

// PLAN.md §19 — positioning annotation cards level with the passage they point
// at, inside the PDF panel.
//
// **A sibling of components/margin-notes/use-margin-notes-layout.ts, not a
// reuse of it — a deliberate deviation from this phase's plan.** The plan
// proposed generalising that hook's `Editor` dependency into a pluggable
// source. Written out, the generalisation would have touched the context, the
// hook, and all three of its working consumers (AnnotationList,
// CommentEntryList, EditorAnnotationRail) to serve a fourth surface that
// shares none of the parts that make it complicated: no TipTap editor, no
// `coordsAtPos`, no per-keystroke re-resolution, no portal, and a different
// change signal (pdfjs events rather than ProseMirror transactions). What the
// two genuinely share is the packing rule, and that was already extracted —
// `packMarginNotes` is imported here unchanged.
//
// This follows the precedent PLAN.md §13c set when AnnotationList was
// un-shared from CommentEntryList: the two sides stopped having the same
// rendering problem, so they stopped sharing a component. Same here.

export type PdfMarginNotesOptions = {
  /**
   * Viewport-space top edge for each card that currently has a visible anchor,
   * keyed by annotation id. Ids absent from the map are treated as anchorless
   * and cascade to the end of the panel — which for a PDF is the normal state
   * of most cards, since pdfjs only renders a few pages at a time.
   */
  resolveTops: () => Map<string, number>;
  /** Card ids in render order — the effect's identity, so adding or reordering re-observes. */
  ids: string[];
  /** Fired when the set of *positionable* ids changes, so the panel can grey the rest. */
  onAnchoredIdsChange?: (ids: Set<string>) => void;
  /** Subscribe to "the rendering moved" — pdfjs scroll/render/scale events. Returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Whether to position at all. False below the breakpoint, where the panel is a plain list. */
  enabled: boolean;
};

function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Positions each card, imperatively.
 *
 * Everything positional is written straight to `element.style` and never held
 * in React state — the same rule (and the same reason) the doc-side hook
 * states: position depends on measurements only knowable after a paint, so
 * routing them through state would mean a render per measurement, and this
 * re-measures on every scroll frame. The one thing that *does* go through
 * state is which ids are anchored at all, because that decides what renders
 * where rather than merely where it sits.
 */
export function usePdfMarginNotes({ resolveTops, ids, onAnchoredIdsChange, subscribe, enabled }: PdfMarginNotesOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [anchoredIds, setAnchoredIds] = useState<Set<string>>(() => new Set());

  const resolveTopsRef = useRef(resolveTops);
  const onChangeRef = useRef(onAnchoredIdsChange);
  useEffect(() => {
    resolveTopsRef.current = resolveTops;
    onChangeRef.current = onAnchoredIdsChange;
  });

  const reportedRef = useRef<Set<string> | null>(null);
  const idKey = ids.join(" ");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cards = () => Array.from(container.querySelectorAll<HTMLElement>("[data-margin-note-id]"));

    if (!enabled) {
      // Back to normal flow, dropping every inline style this hook owns — so a
      // viewport narrowed across the breakpoint doesn't leave cards frozen at
      // their last absolute position.
      container.style.height = "";
      for (const card of cards()) {
        card.style.top = "";
        card.style.position = "";
      }
      reportedRef.current = null;
      return;
    }

    let frame = 0;

    const apply = () => {
      const containerTop = container.getBoundingClientRect().top;
      const tops = resolveTopsRef.current();

      const resolved = new Set(tops.keys());
      if (!reportedRef.current || !sameIds(resolved, reportedRef.current)) {
        reportedRef.current = resolved;
        setAnchoredIds(resolved);
        onChangeRef.current?.(resolved);
      }

      const measurements: MarginNoteMeasurement[] = [];
      const byId = new Map<string, HTMLElement>();
      for (const element of cards()) {
        const id = element.dataset.marginNoteId;
        if (!id) continue;
        byId.set(id, element);
        const top = tops.get(id);
        measurements.push({
          id,
          // Relative to the panel's own scroller, not the viewport — the cards
          // are positioned inside it.
          targetTop: top === undefined ? null : top - containerTop + container.scrollTop,
          // offsetHeight, not the rect: a card mid-flash carries a background
          // transition, and offsetHeight is unaffected by it.
          height: element.offsetHeight,
        });
      }

      const { placements, height } = packMarginNotes(measurements);
      for (const placement of placements) {
        const element = byId.get(placement.id);
        if (!element) continue;
        element.style.position = "absolute";
        element.style.top = `${placement.top}px`;
      }
      // Absolutely positioned children contribute nothing to the container's
      // height, so it has to be told — otherwise the panel never scrolls.
      container.style.height = `${height}px`;
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };

    schedule();

    // Card heights change with no content change at all — a reply composer
    // opening, a delete confirmation appearing.
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    for (const card of cards()) observer.observe(card);

    window.addEventListener("resize", schedule);
    const unsubscribe = subscribe(schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      unsubscribe();
    };
  }, [enabled, idKey, subscribe]);

  const isAnchored = useCallback((id: string) => anchoredIds.has(id), [anchoredIds]);

  return { containerRef, anchoredIds, isAnchored };
}
