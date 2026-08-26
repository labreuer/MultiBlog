"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { packMarginNotes, type MarginNoteMeasurement } from "@/lib/margin-notes-layout";
import { useMarginNotes } from "./margin-notes-context";

// Viewport-space top edge (a `getBoundingClientRect().top`-style number) for
// each card that currently has a live anchor, keyed by the card's own
// `data-margin-note-id`. Ids absent from the map are treated as anchorless.
// Surfaces differ in how they answer this — a post comment reads its stored
// `anchorFrom`, a doc annotation scans the live document for its mark — which
// is the whole reason this is a callback rather than a prop shape.
//
// Called over *every* entry, not only the ones currently in the rail: this is
// also what tells the caller which entries belong there at all, so an entry
// sitting in the bottom list has to be resolvable from here or it could never
// move up.
export type ResolveMarginNoteTops = (editor: Editor) => Map<string, number>;

export type MarginNotesLayoutOptions = {
  resolveTops: ResolveMarginNoteTops;
  // The card ids in current render order. Used only as the effect's identity:
  // adding, removing, or reordering cards has to re-attach the per-card
  // ResizeObserver, whereas a card merely growing does not (the observer
  // catches that itself).
  ids: string[];
  // Fired only when the set of resolvable ids actually changes — never on
  // every measurement pass, which happens per keystroke on a live doc. The
  // reading surfaces hold this in state and use it to decide which entries
  // render in the rail and which stay in the section below (PLAN.md §18b);
  // that is a genuine render-affecting decision, unlike the positions
  // themselves, which are written straight to the DOM.
  onAnchoredIdsChange?: (ids: Set<string>) => void;
  // Present only for a surface whose *article* scrolls inside its own box
  // rather than with the page — today that means the doc editor, whose
  // `.editorContent` is an `overflow-y: auto` frame (EditorChrome.module.css).
  // Two things follow from it, both wrong to apply elsewhere: cards whose
  // anchor has scrolled out of that frame are hidden rather than placed, and
  // a scroll listener is attached at all. A page-scrolled surface needs
  // neither — the article and the rail move together, so every card's offset
  // within its container is invariant under scroll.
  bounds?: () => { top: number; bottom: number } | null;
  // False to leave every card in normal flow — no absolute positioning, no
  // measurement, no observers — while the rail itself still renders. The doc
  // editor's phone-landscape focus mode is the only caller that passes it
  // (PLAN.md §18c): there the rail is a scrollable queue in document order
  // rather than a margin, so aligning a card with its passage is not merely
  // unnecessary but wrong — it would fight the rail's own scrolling, since
  // `targetTop` is measured against a container whose top moves as you
  // scroll it.
  //
  // Distinct from `wide` being false, which means "no rail at all". This
  // means "a rail, laid out by CSS". Consumers therefore get two booleans
  // back, not one.
  positioned?: boolean;
};

// How far above the visible band an anchor may sit and still have its card
// drawn: enough that a card whose quote is half-scrolled off the top stays
// put rather than blinking out mid-scroll.
const BOUNDS_SLACK = 120;

function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// Positions each card level with the passage it belongs to (PLAN.md §18).
//
// Everything positional here is deliberately imperative — a card's `top` is
// written straight to `element.style`, never held in React state. Position
// depends on measurements (`coordsAtPos`, `offsetHeight`) that are only
// knowable after a paint, so routing them back through state would mean a
// render per measurement, and the doc surfaces re-measure on every remote
// keystroke. pseudo-border.ts already sets this precedent for the same reason.
// The one thing that *does* go through state is which ids are anchored at all,
// because that decides what renders where rather than merely where it sits.
export function useMarginNotesLayout({
  resolveTops,
  ids,
  onAnchoredIdsChange,
  bounds,
  positioned = true,
}: MarginNotesLayoutOptions) {
  const context = useMarginNotes();
  const containerRef = useRef<HTMLDivElement>(null);
  const editor = context?.editor ?? null;
  const subscribe = context?.subscribe;
  // There is a rail at all once there's a provider, a qualifying viewport and
  // a mounted editor to measure. Consumers key their whole split off this, so
  // every other case renders the one plain stacked list — including a JS
  // failure, which leaves every card in the section below rather than
  // stranding the anchored ones in a column that never got positioned.
  const live = (context?.wide ?? false) && editor !== null;
  // …and its cards are positioned against their passages unless the caller
  // has asked for flow layout. Everything below this line is about the
  // positioned case; `live && !positioned` deliberately falls into the same
  // teardown branch as "no rail", because a queue wants exactly what that
  // branch leaves behind: no inline styles and no observers.
  const anchored = live && positioned;

  // The effect below runs on a small, stable dependency list so it isn't
  // tearing down observers every render; anything that changes per render
  // reaches it through a ref instead.
  const resolveTopsRef = useRef(resolveTops);
  const boundsRef = useRef(bounds);
  const onAnchoredIdsChangeRef = useRef(onAnchoredIdsChange);
  useEffect(() => {
    resolveTopsRef.current = resolveTops;
    boundsRef.current = bounds;
    onAnchoredIdsChangeRef.current = onAnchoredIdsChange;
  });

  // What was last reported upward, so a per-keystroke measurement pass that
  // finds the same set does nothing at all.
  const reportedIdsRef = useRef<Set<string> | null>(null);

  const idKey = useMemo(() => ids.join(" "), [ids]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cards = () => Array.from(container.querySelectorAll<HTMLElement>("[data-margin-note-id]"));

    if (!anchored || !editor) {
      // Back to normal flow: drop every inline style this hook owns, so a
      // viewport narrowed across the breakpoint doesn't leave cards frozen at
      // their last absolute position.
      container.style.height = "";
      for (const card of cards()) {
        card.style.top = "";
        card.style.visibility = "";
      }
      reportedIdsRef.current = null;
      return;
    }

    let frame = 0;

    const apply = () => {
      const containerTop = container.getBoundingClientRect().top;
      const tops = resolveTopsRef.current(editor);
      const band = boundsRef.current?.() ?? null;

      const resolved = new Set(tops.keys());
      if (!reportedIdsRef.current || !sameIds(resolved, reportedIdsRef.current)) {
        reportedIdsRef.current = resolved;
        onAnchoredIdsChangeRef.current?.(resolved);
      }

      const elements = cards();
      const measurements: MarginNoteMeasurement[] = [];
      const hidden: HTMLElement[] = [];
      const byId = new Map<string, HTMLElement>();

      for (const element of elements) {
        const id = element.dataset.marginNoteId;
        if (!id) continue;
        const top = tops.get(id);
        // In a bounded surface an anchorless card has nowhere to go — the
        // rail is a fixed-height window onto the visible text, not a list
        // with an end to append to — so it is simply not drawn. That is what
        // makes the doc editor show presently-anchored annotations only,
        // with nothing accumulating below (PLAN.md §18c).
        if (band && (top === undefined || top < band.top - BOUNDS_SLACK || top > band.bottom)) {
          hidden.push(element);
          continue;
        }
        byId.set(id, element);
        measurements.push({
          id,
          targetTop: top === undefined ? null : top - containerTop,
          // offsetHeight, not the rect, because a card mid-flash carries a
          // CSS transition on background only — and because `visibility:
          // hidden` (below) keeps layout, so a card returning to view has a
          // real height to pack with rather than a zero.
          height: element.offsetHeight,
        });
      }

      const { placements, height } = packMarginNotes(measurements);
      for (const placement of placements) {
        const element = byId.get(placement.id);
        if (!element) continue;
        element.style.top = `${placement.top}px`;
        element.style.visibility = "";
      }
      for (const element of hidden) {
        element.style.visibility = "hidden";
      }

      // A bounded rail is sized by its own CSS (it stretches to the editor
      // frame); an unbounded one has absolutely positioned children that
      // contribute nothing to its height, so it needs to be told.
      container.style.height = band ? "" : `${height}px`;
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };

    schedule();

    // Card heights change without any content change at all — expanding a
    // reply composer, a delete confirmation appearing. Observing the editor
    // too catches the article reflowing (a late font, an image) without a
    // ProseMirror transaction to hear about it.
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    observer.observe(editor.view.dom);
    for (const card of cards()) observer.observe(card);

    window.addEventListener("resize", schedule);
    // Local edits and, on a live doc, remote ones that arrive as real
    // transactions.
    editor.on("update", schedule);
    // The reading views push remote content in with `emitUpdate: false`
    // (use-live-doc-content.ts), so `update` above never fires for them —
    // this is the channel those surfaces report through instead.
    const unsubscribe = subscribe?.(schedule);
    // Only a bounded surface needs this; see the option's own note. Capture
    // phase because scroll doesn't bubble, and the scroller here is a nested
    // element rather than the document.
    if (bounds) window.addEventListener("scroll", schedule, true);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      editor.off("update", schedule);
      unsubscribe?.();
      if (bounds) window.removeEventListener("scroll", schedule, true);
    };
    // `bounds` is read for its presence, not its identity — a surface either
    // is bounded for its whole lifetime or isn't — and its current value is
    // reached through boundsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchored, editor, subscribe, idKey]);

  return { live, anchored, containerRef, railElement: context?.railElement ?? null };
}
