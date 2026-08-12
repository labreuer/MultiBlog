"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { captureRelativeRange, resolveRelativeRange, type RelativeRange } from "./yjs-relative-anchor";
import { setPendingAnnotation } from "./pending-annotation-extension";
import { placePopover, popoverBoundsFor, provisionalPlacement, type PopoverPlacement } from "./popover-placement";

export type PendingEditorSelection = { relRange: RelativeRange; quotedText: string };

export type EditorAnnotationWidget = {
  pending: PendingEditorSelection | null;
  placement: PopoverPlacement | null;
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
 * The doc *editor*'s counterpart to useSelectionPopover (PLAN.md §18,
 * COLLAB.md §5) — captures a selection as a pair of Y.RelativePositions
 * instead of offsets, since this editor (unlike either reading view) is
 * bound through Collaboration and has the ySyncPlugin binding a relative
 * position needs to convert against. That buys what useSelectionPopover's
 * own text-search reresolve cannot: no fallback search, and a range
 * survives an edit made *inside* it, not merely around it.
 */
export function useEditorAnnotationWidget({
  editorRef,
  containerRef,
  userColor,
}: {
  editorRef: RefObject<Editor | null>;
  containerRef: RefObject<HTMLElement | null>;
  userColor: string;
}): EditorAnnotationWidget {
  const [pending, setPending] = useState<PendingEditorSelection | null>(null);
  // The logical position `placement` is derived from — set by capture and
  // reresolve, distinct from `placement` itself (screen coordinates,
  // recomputed on scroll/resize too without needing a fresh resolve).
  const [resolvedTo, setResolvedTo] = useState<number | null>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Read inside reresolve, which runs off the editor's "update" event and
  // would otherwise close over whatever `pending` was when first wired.
  const pendingRef = useRef<PendingEditorSelection | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  function clear(liveEditor?: Editor | null) {
    // A full no-op — no state update, no dispatch — when there's nothing
    // pending to clear. Load-bearing, not a micro-optimization: `capture`
    // calls this on *every* onSelectionUpdate with an empty selection,
    // which on this editor (unlike the reading view's) fires on every
    // keystroke, not just a mouse drag. Two hazards that matter only on an
    // actively-typed, Collaboration-bound editor, neither of which applies
    // on the reading view this shape was borrowed from: (1) `setPending`/
    // `setResolvedTo` re-render CollabEditorBody's whole subtree on every
    // keystroke even when the value doesn't change, racing React's
    // reconciliation against ProseMirror's own DOM ownership of the
    // contenteditable; (2) `setPendingAnnotation` dispatches a transaction
    // on the same view, reentering the editor's own dispatchTransaction
    // while it's still unwinding the transaction that triggered this
    // callback (ProseMirror's dispatch is documented as not reentrant-safe).
    // Both were live suspects in a cursor-desync failure caught by
    // e2e/quote-anchoring.spec.ts's "an edit outside the quote moves the
    // anchor" case, 2026-08-12 — this guard removes both at once rather
    // than resolving which one was the actual cause.
    if (pendingRef.current === null) return;
    setPending(null);
    setResolvedTo(null);
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
    const relRange = captureRelativeRange(liveEditor, from, to);
    if (!relRange) {
      // No Collaboration binding — shouldn't happen on this editor, but the
      // honest response is "no widget" rather than falling back to offsets
      // this hook was written specifically to avoid.
      clear(liveEditor);
      return;
    }
    setPending({ relRange, quotedText });
    setResolvedTo(to);
    setPlacement(provisionalPlacement(liveEditor.view.coordsAtPos(to)));
    setPendingAnnotation(liveEditor.view, { from, to, color: userColor });
  }

  function reresolve(liveEditor: Editor) {
    const current = pendingRef.current;
    if (!current) return;
    const resolved = resolveRelativeRange(liveEditor, current.relRange);
    if (!resolved) {
      clear(liveEditor);
      return;
    }
    setResolvedTo(resolved.to);
    setPendingAnnotation(liveEditor.view, { from: resolved.from, to: resolved.to, color: userColor });
  }

  function resolveAnchor(liveEditor: Editor): { from: number; to: number } | null {
    const current = pendingRef.current;
    return current ? resolveRelativeRange(liveEditor, current.relRange) : null;
  }

  // Dismiss on a click outside the editor — same convention as
  // useSelectionPopover.
  useEffect(() => {
    if (!pending) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        clear();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- containerRef/editorRef are stable refs
  }, [pending]);

  // Screen coordinates for whatever `resolvedTo` currently is. Same
  // two-phase bootstrap as useSelectionPopover: `capture` already seeded a
  // provisional placement in the same batch as `resolvedTo`, so the popover
  // exists in the DOM by the time this runs and `popoverRef.current` is
  // already the real element — this pass corrects for its actual measured
  // size before the browser ever paints the provisional one.
  useLayoutEffect(() => {
    if (resolvedTo === null) return;
    function computePlacement() {
      const liveEditor = editorRef.current;
      const el = popoverRef.current;
      if (!liveEditor || !el || resolvedTo === null) return;
      const anchor = liveEditor.view.coordsAtPos(resolvedTo);
      const { width, height } = el.getBoundingClientRect();
      const next = placePopover(anchor, { width, height }, popoverBoundsFor(containerRef.current));
      setPlacement((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }
    computePlacement();
    // Capture phase: the editor's own scroll frame (EditorChrome.module.css's
    // .editorContent) scrolls, not the window, and that scroll event doesn't
    // bubble.
    window.addEventListener("scroll", computePlacement, true);
    window.addEventListener("resize", computePlacement);
    return () => {
      window.removeEventListener("scroll", computePlacement, true);
      window.removeEventListener("resize", computePlacement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editorRef/containerRef are stable refs
  }, [resolvedTo]);

  return { pending, placement, popoverRef, capture, clear, reresolve, resolveAnchor };
}
