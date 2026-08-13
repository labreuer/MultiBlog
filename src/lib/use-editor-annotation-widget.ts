"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { captureRelativeRange, resolveRelativeRange, type RelativeRange } from "./yjs-relative-anchor";
import { setPendingAnnotation } from "./pending-annotation-extension";
import { placePopover, popoverBoundsFor, provisionalPlacement, type PopoverPlacement } from "./popover-placement";

export type PendingEditorSelection = { relRange: RelativeRange; quotedText: string };

/** The collapsed marker's rendered size — mirrored by `.annotateMarker`'s CSS. */
export const ANNOTATE_MARKER_SIZE = 28;
/** Breathing room between the document's right edge and the marker. */
const MARKER_GAP = 8;

export type EditorAnnotationWidget = {
  pending: PendingEditorSelection | null;
  /**
   * Where the collapsed marker sits — beside the document, level with the
   * start of the selection. Null when there's a selection but its anchor has
   * scrolled out of the editor's own frame, which hides the marker rather
   * than stranding it at an edge (same rule EditorAnnotationRail's bounded
   * cards follow).
   */
  marker: PopoverPlacement | null;
  /** True once the marker has been clicked and the composer is open. */
  expanded: boolean;
  expand: () => void;
  /** Where the expanded composer sits — measured, anchored to the marker. */
  popoverPlacement: PopoverPlacement | null;
  popoverRef: RefObject<HTMLDivElement | null>;
  capture: (editor: Editor) => void;
  clear: (editor?: Editor | null) => void;
  /** Wire to the editor's own "update" event — every local or remote transaction. */
  reresolve: (editor: Editor) => void;
  /**
   * Resolves the captured range against the document *right now* — the
   * payoff PLAN.md §18/COLLAB.md §5 exist for: called at submit time, not
   * composed time, so whatever concurrent typing happened while the
   * composer sat open is reflected in the final anchor with no
   * re-verification pass. Null means the anchored content is gone.
   */
  resolveAnchor: (editor: Editor) => { from: number; to: number } | null;
};

/**
 * The doc *editor*'s counterpart to useSelectionPopover (PLAN.md §18f,
 * COLLAB.md §5), and deliberately a much quieter one.
 *
 * **Two stages, because selecting text while editing is not a request to
 * annotate.** On a reading view a selection is a strong signal — there is
 * little else to do with text you cannot edit — so `useSelectionPopover`
 * opens its composer immediately. In an editor, selecting is what you do to
 * bold a word, move a sentence, or just read with the mouse; a panel over
 * the text on every one of those is noise. So stage one is a marker *beside
 * the document*, never over it: it says an annotation is possible and
 * nothing more. Only clicking it (`expand`) opens the composer, which is
 * also what defers creating a DRAFT row and its live connection — the same
 * cost `AnnotationPopover`'s own "Annotate" button defers on the reading
 * side, moved out to the marker so the expanded state can go straight to a
 * composer rather than to a second button.
 *
 * The anchor itself is a pair of Y.RelativePositions rather than offsets,
 * since this editor (unlike either reading view) is Collaboration-bound and
 * has the ySyncPlugin binding to convert against. That buys what a
 * text-search re-resolve cannot: no fallback search, and a range that
 * survives an edit made *inside* it.
 */
export function useEditorAnnotationWidget({
  editorRef,
  containerRef,
  getFrame,
  userColor,
}: {
  editorRef: RefObject<Editor | null>;
  containerRef: RefObject<HTMLElement | null>;
  /**
   * The editor's own scrolling text box. Supplied by the caller rather than
   * queried here for two reasons: `src/lib` doesn't import from
   * `src/components` (so `EDITOR_SCROLL_ATTRIBUTE` isn't reachable), and a
   * caller-scoped lookup can't match some *other* editor's frame the way a
   * global `document.querySelector` could. Its right edge is what "beside
   * the document" means, and its top/bottom bound where the marker is drawn
   * at all.
   */
  getFrame: () => HTMLElement | null;
  userColor: string;
}): EditorAnnotationWidget {
  const [pending, setPending] = useState<PendingEditorSelection | null>(null);
  // The document position the marker is levelled against — the *start* of
  // the selection, so the marker lines up with where the passage begins
  // rather than trailing off its end.
  const [anchorPos, setAnchorPos] = useState<number | null>(null);
  const [marker, setMarker] = useState<PopoverPlacement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [popoverPlacement, setPopoverPlacement] = useState<PopoverPlacement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Read inside reresolve/clear, which run off editor events and would
  // otherwise close over whatever `pending` was when first wired.
  const pendingRef = useRef<PendingEditorSelection | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const getFrameRef = useRef(getFrame);
  useEffect(() => {
    getFrameRef.current = getFrame;
  });

  // `expand` needs the marker's current position to seed the panel's
  // provisional placement, and runs from a click handler rather than a
  // render — a ref, not the state value, keeps it out of `expand`'s
  // dependency list and so keeps that callback stable.
  const markerRef = useRef<PopoverPlacement | null>(null);
  useEffect(() => {
    markerRef.current = marker;
  }, [marker]);

  const clear = useCallback(
    (liveEditor?: Editor | null) => {
      // A full no-op — no state update, no dispatch — when there's nothing
      // pending to clear. Load-bearing, not a micro-optimization: `capture`
      // calls this on *every* onSelectionUpdate with an empty selection,
      // which on this editor (unlike the reading view's) fires on every
      // keystroke, not just a mouse drag. Two hazards that matter only on an
      // actively-typed, Collaboration-bound editor: (1) the setState calls
      // below re-render CollabEditorBody's whole subtree per keystroke even
      // when nothing changed, racing React's reconciliation against
      // ProseMirror's own DOM ownership of the contenteditable; (2)
      // `setPendingAnnotation` dispatches a transaction on the same view,
      // reentering the editor's own dispatchTransaction while it's still
      // unwinding the transaction that triggered this callback (ProseMirror
      // documents dispatch as not reentrant-safe). Both were live suspects
      // in a cursor-desync failure caught by e2e/quote-anchoring.spec.ts's
      // "an edit outside the quote moves the anchor" case, 2026-08-12 —
      // this guard removes both at once.
      if (pendingRef.current === null) return;
      setPending(null);
      setAnchorPos(null);
      setMarker(null);
      setExpanded(false);
      const target = liveEditor ?? editorRef.current;
      if (target) setPendingAnnotation(target.view, null);
    },
    [editorRef],
  );

  const capture = useCallback(
    (liveEditor: Editor) => {
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
      const relRange = captureRelativeRange(liveEditor, from, to);
      if (!relRange) {
        // No Collaboration binding — shouldn't happen on this editor, but
        // the honest response is "no widget" rather than falling back to the
        // offsets this hook exists specifically to avoid trusting.
        clear(liveEditor);
        return;
      }
      // Re-selecting collapses any open composer back to a marker: the
      // expanded panel described the *previous* range, and silently
      // re-pointing it at a new one would be worse than closing it.
      setPending({ relRange, quotedText });
      setAnchorPos(from);
      setExpanded(false);
      setPendingAnnotation(liveEditor.view, { from, to, color: userColor });
    },
    [clear, containerRef, userColor],
  );

  const reresolve = useCallback(
    (liveEditor: Editor) => {
      const current = pendingRef.current;
      if (!current) return;
      const resolved = resolveRelativeRange(liveEditor, current.relRange);
      if (!resolved) {
        clear(liveEditor);
        return;
      }
      setAnchorPos(resolved.from);
      setPendingAnnotation(liveEditor.view, { from: resolved.from, to: resolved.to, color: userColor });
    },
    [clear, userColor],
  );

  const resolveAnchor = useCallback((liveEditor: Editor) => {
    const current = pendingRef.current;
    return current ? resolveRelativeRange(liveEditor, current.relRange) : null;
  }, []);

  // Seeds a provisional placement in the same batch as `expanded`, which is
  // what makes the measured one below possible at all: the panel has to be
  // in the DOM before its size can be read, and it only renders once it has
  // *a* placement. Same two-phase bootstrap useSelectionPopover uses, keyed
  // off the marker rather than a text position.
  const expand = useCallback(() => {
    const current = markerRef.current;
    if (current) {
      setPopoverPlacement(provisionalPlacement({ ...current, bottom: current.top + ANNOTATE_MARKER_SIZE }));
    }
    setExpanded(true);
  }, []);

  // Dismiss on a click outside the editor column — same convention as
  // useSelectionPopover. The expanded composer lives outside `containerRef`
  // visually but inside it in the DOM, so clicking within it doesn't count
  // as outside.
  useEffect(() => {
    if (!pending) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        clear();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [pending, clear, containerRef]);

  // Where the marker goes: beside the document's right edge, level with the
  // selection's start. Recomputed against live coordinates on scroll/resize
  // rather than frozen at capture time — the editor's text box scrolls
  // independently of the page, so a frozen position drifts off its passage
  // the moment anyone scrolls.
  useLayoutEffect(() => {
    if (anchorPos === null) return;
    function reposition() {
      const liveEditor = editorRef.current;
      const frame = getFrameRef.current();
      if (!liveEditor || !frame || anchorPos === null) return;
      let coords: { top: number; bottom: number; left: number };
      try {
        coords = liveEditor.view.coordsAtPos(anchorPos);
      } catch {
        // A position the current document can't resolve — treated the same
        // as scrolled-out-of-frame rather than thrown.
        setMarker(null);
        return;
      }
      const frameRect = frame.getBoundingClientRect();
      // Out of the editor's own visible band: no marker, rather than one
      // pinned to an edge pointing at text nobody can see.
      if (coords.top < frameRect.top || coords.top > frameRect.bottom) {
        setMarker(null);
        return;
      }
      // Preferred spot is genuinely outside the text column. Clamped into
      // the viewport for the narrow end of the supported range, where the
      // column nearly fills the window and there is no true gutter to sit
      // in — body's `overflow-x: hidden` would otherwise clip the marker
      // away entirely (globals.css).
      const preferred = frameRect.right + MARKER_GAP;
      const maxLeft = window.innerWidth - ANNOTATE_MARKER_SIZE - MARKER_GAP;
      const next = { top: coords.top, left: Math.max(MARKER_GAP, Math.min(preferred, maxLeft)) };
      setMarker((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }
    reposition();
    // Capture phase: the editor's text box scrolls, not the window, and a
    // scroll event from a nested element doesn't bubble.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchorPos, editorRef]);

  // The expanded composer, anchored to the marker rather than to the text —
  // it opens *where the marker was*, so the click and its result are in the
  // same place. `placePopover` still slides it left to fit, which at the
  // narrow end of the range is what puts it back over the document; there
  // is no room to do otherwise, and by then it's a panel the reader
  // deliberately opened rather than one that appeared over their work.
  useLayoutEffect(() => {
    if (!expanded || !marker) return;
    function reposition() {
      const el = popoverRef.current;
      if (!el || !marker) return;
      const { width, height } = el.getBoundingClientRect();
      const anchor = { top: marker.top, bottom: marker.top + ANNOTATE_MARKER_SIZE, left: marker.left };
      const next = placePopover(anchor, { width, height }, popoverBoundsFor(containerRef.current));
      setPopoverPlacement((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [expanded, marker, containerRef]);

  return {
    pending,
    marker,
    expanded,
    expand,
    popoverPlacement,
    popoverRef,
    capture,
    clear,
    reresolve,
    resolveAnchor,
  };
}
