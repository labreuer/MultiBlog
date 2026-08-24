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
   * Viewport-space top edge for each annotation whose passage is on screen right
   * now, keyed by id. An id absent from the map is not in the rail at all — the
   * panel hides it, which is what keeps the packed column within the panel's own
   * height — and for a PDF that is the normal state of most cards, since only a
   * few pages of a long document are ever on screen.
   */
  resolveTops: () => Map<string, number>;
  /** Card ids in render order — the effect's identity, so adding or reordering re-observes. */
  ids: string[];
  /** Fired when the set of *positionable* ids changes, so the panel can hide the rest. */
  onAnchoredIdsChange?: (ids: Set<string>) => void;
  /** Subscribe to "the rendering moved" — pdfjs scroll/render/scale events. Returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Whether to position at all. False below the breakpoint, and in the panel's "All" list mode. */
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
        // With the inline position dropped these are back in normal flow, so
        // they are no longer where `data-placed` claims. Leaving it set would
        // reveal them at a stale position for a frame on the way back into rail
        // mode — the same defect the flag exists to prevent.
        delete card.dataset.placed;
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

      // **A card is hidden until this pass has positioned it** (`data-placed`,
      // consumed by PdfAnnotations.module.css), because membership and
      // placement cannot happen in the same frame. `setAnchoredIds` above is
      // what drops a newly-arrived card's `display: none`, and React applies it
      // *after* this function returns — so on this pass the card is still
      // `display: none`, gets skipped by the `offsetParent` guard below, and
      // receives no `top`. It therefore paints once in normal flow, at the top
      // of the container, before the next pass moves it to its passage.
      //
      // That next pass is guaranteed: going from `display: none` to a real box
      // is a resize, and every card is observed. So the flag costs one frame of
      // invisibility and buys never painting a card in the wrong place — which
      // reads as the card loading at the top of the panel and jumping.
      const measurements: MarginNoteMeasurement[] = [];
      const byId = new Map<string, HTMLElement>();
      for (const element of cards()) {
        const id = element.dataset.marginNoteId;
        if (!id) continue;
        // `display: none` — a card whose passage is off screen, which the panel
        // keeps mounted (its reply composer may be live) but out of the rail.
        // Skipped rather than measured: at zero height it would otherwise take
        // a slot in the cascade and pad the column with a gap apiece.
        if (element.offsetParent === null) {
          delete element.dataset.placed;
          continue;
        }
        const top = tops.get(id);
        // **Still on screen, but no longer in the rail** — the mirror of the
        // arriving case above, and the same one-frame gap: `setAnchoredIds` has
        // been called with a set this card is absent from, and React applies the
        // `display: none` that follows *after* this function returns. Left to
        // fall through, it would be measured with a null `targetTop`, which the
        // packer reads as "anchorless" and places at the end of the cascade —
        // so a card leaving at the bottom of the panel jumps up behind the last
        // anchored one for a frame before vanishing.
        //
        // Skipped entirely instead, keeping the `top` it already has until it
        // is hidden. Nothing is lost by that: membership ends only once the
        // passage has left the band, by which point the card is off the panel's
        // edge anyway. A PDF card's `targetTop` is never *legitimately* null —
        // an annotation with no target never enters `tops` at all, so it is
        // never in the rail — which is why this can be a plain `continue`
        // rather than the doc rail's genuine anchorless case.
        if (top === undefined) continue;
        byId.set(id, element);
        measurements.push({
          id,
          // Relative to the panel's own scroller, not the viewport — the cards
          // are positioned inside it.
          targetTop: top - containerTop + container.scrollTop,
          // offsetHeight, not the rect: a card mid-flash carries a background
          // transition, and offsetHeight is unaffected by it.
          height: element.offsetHeight,
        });
      }

      // `minTop: -Infinity`, unlike the doc rail's default 0: here the
      // container's top edge is the viewport's, so a card above it is arriving
      // rather than misplaced — clipped above the panel or under the panel's
      // own chrome, sliding into view as its passage scrolls down. Clamping it
      // to 0 is what made a card appear at full height in one frame.
      const { placements, height } = packMarginNotes(measurements, { minTop: -Infinity });
      for (const placement of placements) {
        const element = byId.get(placement.id);
        if (!element) continue;
        element.style.position = "absolute";
        element.style.top = `${placement.top}px`;
        // **Marks the card as safe to show** — see the note above the loop.
        element.dataset.placed = "";
      }
      // Absolutely positioned children contribute nothing to the container's
      // height, so it has to be told — otherwise the panel never scrolls.
      // Floored at 0: with every member still in the lead-in band above the
      // viewport the cascade's bottom is negative, and a negative `height` is
      // not a parse error but a silently ignored declaration, which would leave
      // the container frozen at whatever it last measured.
      container.style.height = `${Math.max(0, height)}px`;
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
