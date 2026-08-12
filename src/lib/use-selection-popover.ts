"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { setPendingAnnotation } from "./pending-annotation-extension";
import { findQuoteOccurrences } from "./quote-occurrences";
import { placePopover, popoverBoundsFor, POPOVER_GAP, type PopoverPlacement } from "./popover-placement";

export type PendingSelection = {
  from: number;
  to: number;
  quotedText: string;
};

/**
 * The preferred (unclamped) spot for a popover about to open at `pos` — good
 * enough to render at for one layout pass, which is what makes the measured
 * placement possible: the popover has to exist in the DOM before its size can
 * be read. Deliberately skips clamping rather than guessing a size, so the
 * only thing ever painted is either this or the fully-measured result.
 */
function provisionalPlacement(liveEditor: Editor, pos: number): PopoverPlacement {
  const coords = liveEditor.view.coordsAtPos(pos);
  return { top: coords.bottom + POPOVER_GAP, left: coords.left + POPOVER_GAP };
}

export type SelectionPopover = {
  // No top/left on the selection itself — where its popover sits is derived
  // below, from `to`, rather than frozen when the selection was made.
  pending: PendingSelection | null;
  /** Wire to the editor's selection updates; captures or clears accordingly. */
  capture: (liveEditor: Editor) => void;
  clear: (liveEditor?: Editor | null) => void;
  /** Wire to the content-push choke point — see the note on the function. */
  reresolve: (liveEditor: Editor) => void;
  // Read alongside the caller's own popover state (`pending && placement`),
  // never on its own — see the note on not clearing it, below.
  placement: PopoverPlacement | null;
  /** Attach to the open popover's root element so it can be measured. */
  popoverRef: RefObject<HTMLDivElement | null>;
  // Call in the same handler that opens a popover *other than* the pending
  // selection's own, so the provisional placement and that popover's state
  // land in one React batch.
  openAt: (liveEditor: Editor, pos: number) => void;
};

/**
 * A reader's in-progress text selection, the decoration marking it as "about
 * to be acted on" (PLAN.md §13f), and the position of whatever popover is
 * open over it (§14i).
 *
 * Selection and placement are one hook rather than two because they are
 * genuinely mutually dependent: placement needs the anchor the selection
 * provides, and capturing a selection needs to seed a provisional placement in
 * the same React batch, so that a popover never renders without a position.
 * Splitting them produces a cycle rather than a layering.
 *
 * Shared by both reading surfaces: the gesture is identical whether the
 * selection is about to become an annotation (/doc/[slug]) or a doc link
 * (/side-by-side) — only the popover that opens over it differs, which is the
 * caller's business, not this hook's.
 */
export function useSelectionPopover({
  editorRef,
  containerRef,
  userColor,
  externalAnchorPos = null,
  reflowKey,
}: {
  editorRef: RefObject<Editor | null>;
  // Doubles as the region a click counts as "inside", and as the starting
  // point for finding the [data-popover-bounds] the popover is clamped into.
  containerRef: RefObject<HTMLElement | null>;
  // The viewer's own color (PLAN.md §13f), for the pending decoration.
  userColor: string;
  // An anchor belonging to a popover this hook doesn't own — the side-by-side
  // surface's click-routing popovers (§14j), which are anchored to an existing
  // link rather than to a live selection. Takes precedence when set, since at
  // most one popover is ever open at a time.
  externalAnchorPos?: number | null;
  // An extra value whose change can reflow the page under the anchor, beyond
  // the scroll/resize this already listens for.
  reflowKey?: unknown;
}): SelectionPopover {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Read inside the content-push handlers, which run outside React's render
  // cycle and would otherwise close over a stale `pending`.
  const pendingRef = useRef<PendingSelection | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  function openAt(liveEditor: Editor, pos: number) {
    setPlacement(provisionalPlacement(liveEditor, pos));
  }

  function clear(liveEditor?: Editor | null) {
    setPending(null);
    const target = liveEditor ?? editorRef.current;
    if (target) setPendingAnnotation(target.view, null);
  }

  function capture(liveEditor: Editor) {
    const { from, to, empty } = liveEditor.state.selection;
    if (empty || !containerRef.current) {
      clear(liveEditor);
      return;
    }
    const quotedText = liveEditor.state.doc.textBetween(from, to, " ");
    if (!quotedText.trim()) {
      clear(liveEditor);
      return;
    }
    setPending({ from, to, quotedText });
    openAt(liveEditor, to);
    setPendingAnnotation(liveEditor.view, { from, to, color: userColor });
  }

  // PLAN.md §13f — re-resolves the pending selection against the doc after any
  // setContent call (a live remote update or a scrub jump), both of which can
  // move or destroy the text a reader has selected out from under them. The
  // decoration's own position-mapping (pending-annotation-extension.ts's
  // `apply`) already tracks an ordinary transaction; this is the explicit
  // fallback for the case that doesn't hold — a setContent call whose diff
  // isn't a simple insert/delete around the selection.
  function reresolve(liveEditor: Editor) {
    const current = pendingRef.current;
    if (!current) return;
    const doc = liveEditor.state.doc;
    const stillValid =
      current.to <= doc.content.size && doc.textBetween(current.from, current.to, " ") === current.quotedText;
    if (stillValid) return;

    const container = containerRef.current;
    const occurrences = container ? findQuoteOccurrences(doc, current.quotedText) : [];
    if (occurrences.length === 1 && container) {
      const { from, to } = occurrences[0];
      setPending({ from, to, quotedText: current.quotedText });
      openAt(liveEditor, to);
      setPendingAnnotation(liveEditor.view, { from, to, color: userColor });
    } else {
      // No unique match any more — the selected text changed underneath the
      // reader. Close the popover rather than leave it pointing at a range
      // that no longer means what it did.
      clear(liveEditor);
    }
  }

  // Dismiss the pending selection on a click outside the reading surface. The
  // caller dismisses its own other popovers the same way, where it has them.
  useEffect(() => {
    if (!pending) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPending(null);
        if (editorRef.current) setPendingAnnotation(editorRef.current.view, null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- containerRef/editorRef are stable refs
  }, [pending]);

  // Whichever popover is open is anchored to exactly one document position.
  const anchorPos = externalAnchorPos ?? pending?.to ?? null;

  // The one place a popover's final position is decided, against the anchor's
  // *live* coordinates rather than coordinates frozen when it opened. Deriving
  // instead of freezing is the point: a stored top/left goes stale the moment
  // anything reflows under it, and each such reflow used to be patched one at
  // a time. Recomputing covers them uniformly —
  //
  // - a reflow caused by opening the popover itself (the side-by-side group
  //   panel appearing above the columns when a click also switches the active
  //   group), which the provisional placement was computed before
  // - a column scrolling, which a `position: fixed` popover does not follow
  // - the window resizing, which moves the bounds it is clamped into
  //
  // useLayoutEffect so the refinement lands before the browser paints the
  // provisional spot. No need to clear `placement` when nothing is open: every
  // render site reads it only alongside its own popover state, and whichever
  // handler opens a popover sets the provisional placement in the same batch —
  // so a leftover value is never the one painted.
  useLayoutEffect(() => {
    if (anchorPos === null) return;
    function reposition() {
      const liveEditor = editorRef.current;
      const el = popoverRef.current;
      if (!liveEditor || !el || anchorPos === null) return;
      const anchor = liveEditor.view.coordsAtPos(anchorPos);
      const { width, height } = el.getBoundingClientRect();
      const next = placePopover(anchor, { width, height }, popoverBoundsFor(containerRef.current));
      setPlacement((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }
    reposition();
    // Capture phase: a column's own `.scroller` scrolls, not the window, and a
    // scroll event from an inner element doesn't bubble.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editorRef/containerRef are stable refs; reflowKey is an opaque "something moved" signal, not read here
  }, [anchorPos, reflowKey]);

  return { pending, capture, clear, reresolve, placement, popoverRef, openAt };
}
