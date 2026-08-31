"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { setPendingAnnotation } from "./pending-annotation-extension";
import { findQuoteOccurrences } from "./quote-occurrences";
import { POPOVER_GAP, popoverBoundsElement } from "./popover-placement";

export type PendingSelection = {
  from: number;
  to: number;
  quotedText: string;
  /**
   * PLAN.md §13q — the document version these offsets were read against, as
   * a base64 Yjs snapshot. Captured in the same tick as `from`/`to` so the
   * two describe one instant, and null on a surface with no live Y.Doc to
   * capture from.
   */
  atVersion: string | null;
};

export type SelectionPopover = {
  pending: PendingSelection | null;
  /** Wire to the editor's selection updates; captures or clears accordingly. */
  capture: (liveEditor: Editor) => void;
  clear: (liveEditor?: Editor | null) => void;
  /** Wire to the content-push choke point — see the note on the function. */
  reresolve: (liveEditor: Editor) => void;
  /**
   * Attach to the open popover's root element — floating-ui positions the
   * popover through it (left/top written before its first paint, so nothing
   * provisional is ever shown). A callback ref rather than a RefObject:
   * swapping one popover for another at the same anchor (the chooser
   * handing over to the edit popover, PLAN.md §14j) must re-bind autoUpdate
   * to the new element, and only a callback ref makes that mount
   * observable.
   */
  popoverRef: (el: HTMLDivElement | null) => void;
};

/**
 * A reader's in-progress text selection, the decoration marking it as "about
 * to be acted on" (PLAN.md §13f), and the position of whatever popover is
 * open over it (§14i).
 *
 * Selection and placement are one hook rather than two because they are
 * genuinely mutually dependent: placement needs the anchor the selection
 * provides, and a popover must never paint without a position — which is why
 * placement is written straight onto the popover element (floating-ui,
 * below) rather than handed back as state for the caller to thread through.
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
  versionRef,
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
  // what autoUpdate's own scroll/resize/ResizeObserver coverage sees.
  reflowKey?: unknown;
  // PLAN.md §13q — reads the live document's current version. A ref rather
  // than a value for the same reason `editorRef` is one: the surface that
  // owns the Y.Doc (useLiveDocContent) is constructed *after* this hook,
  // because it takes this hook's `capture` as an input. A ref declared by the
  // caller lets both take it and neither depend on the other.
  versionRef?: RefObject<(() => string) | null>;
}): SelectionPopover {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  // The open popover's root element — state rather than a ref, so the
  // placement effect below re-binds when one popover unmounts and another
  // mounts at the same anchor (see SelectionPopover.popoverRef).
  const [popoverEl, setPopoverEl] = useState<HTMLDivElement | null>(null);

  // Read inside the content-push handlers, which run outside React's render
  // cycle and would otherwise close over a stale `pending`.
  const pendingRef = useRef<PendingSelection | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

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
    // PLAN.md §13q — same synchronous tick as reading the selection above.
    // From here on the surface freezes (a pending selection *is* the freeze
    // condition), so the Y.Doc keeps advancing while the render is withheld
    // and any later capture would name a state the reader never saw.
    setPending({ from, to, quotedText, atVersion: versionRef?.current?.() ?? null });
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
      // Re-versioned as well as re-positioned (PLAN.md §13q). This runs only
      // after a `setContent` moved the text out from under the selection, so
      // the offsets now describe the *new* document — pairing them with the
      // version captured against the old one would be the one combination
      // guaranteed to be wrong.
      setPending({ from, to, quotedText: current.quotedText, atVersion: versionRef?.current?.() ?? null });
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

  // The one place a popover's position is decided — floating-ui's
  // computePosition against the anchor's *live* coordinates, re-run by
  // autoUpdate rather than frozen when the popover opened. Deriving instead
  // of freezing is the point: a stored top/left goes stale the moment
  // anything reflows under it, and each such reflow used to be patched one
  // at a time —
  //
  // - a reflow caused by opening the popover itself (the side-by-side group
  //   panel appearing above the columns when a click also switches the
  //   active group) — `reflowKey` in the deps is what covers this, since no
  //   scroll or resize fires for it
  // - a column scrolling, which a `position: fixed` popover does not follow
  //   (autoUpdate's ancestor-scroll listeners, hung off `contextElement`)
  // - the window resizing, which moves the bounds it is clamped into
  // - the popover itself growing (autoUpdate's ResizeObserver)
  //
  // The middleware reproduces the old hand-rolled rules (placePopover, in
  // git history). Horizontal is a *slide* — shift's main axis: the popover
  // is a large fraction of a column's width, so a flip to the anchor's
  // other side would overshoot the left edge about as readily as the
  // preferred spot overshoots the right, and sliding keeps it on the
  // anchor's own line without ever covering the anchor (a point on a line,
  // while the popover sits above or below that whole line). Vertical is a
  // *flip* — the opposite choice for the opposite reason: sliding up would
  // drag the popover over the very text it describes. When neither side
  // fits, flip falls back to the initial below-the-anchor placement and
  // shift's crossAxis clamps it into bounds, accepting the unavoidable
  // overlap — the same clamp that pins a popover whose column scrolled away
  // to the edge it left through, instead of leaving it thousands of pixels
  // off-screen. The bounds are the nearest [data-popover-bounds] ancestor —
  // on /side-by-side, the column pair — intersected with the viewport
  // (popoverBoundsElement), or the viewport alone.
  //
  // useLayoutEffect plus computePosition's microtask lands the position
  // before the newly mounted popover first paints.
  useLayoutEffect(() => {
    if (anchorPos === null || popoverEl === null) return;
    const liveEditor = editorRef.current;
    if (!liveEditor) return;
    let lastRect = new DOMRect(0, 0, 0, 0);
    const reference = {
      getBoundingClientRect: () => {
        const editorNow = editorRef.current;
        if (editorNow) {
          try {
            const coords = editorNow.view.coordsAtPos(anchorPos);
            lastRect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
          } catch {
            // A position the current document can't resolve (a
            // collaborator's edit mid-render): hold the last spot rather
            // than jumping somewhere wrong.
          }
        }
        return lastRect;
      },
      contextElement: liveEditor.view.dom,
    };
    const boundary = popoverBoundsElement(containerRef.current);
    const update = () => {
      void computePosition(reference, popoverEl, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset({ mainAxis: POPOVER_GAP, crossAxis: POPOVER_GAP }),
          flip({ crossAxis: false, boundary, fallbackStrategy: "initialPlacement" }),
          shift({ crossAxis: true, boundary }),
        ],
      }).then(({ x, y }) => {
        Object.assign(popoverEl.style, { left: `${x}px`, top: `${y}px` });
      });
    };
    return autoUpdate(reference, popoverEl, update);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editorRef/containerRef are stable refs; reflowKey is an opaque "something moved" signal, not read here
  }, [anchorPos, popoverEl, reflowKey]);

  return { pending, capture, clear, reresolve, popoverRef: setPopoverEl };
}
