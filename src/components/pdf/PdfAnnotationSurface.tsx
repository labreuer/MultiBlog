"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import PdfViewer, { type PdfViewerHandle } from "./PdfViewer";
import PdfAnnotationPanel, { type PdfAnnotationEntry } from "./PdfAnnotationPanel";
import { attachAnnoClicks, attachAnnoLayers, type AnnoLayerEntry } from "./anno-layer";
import { captureTextTarget, type CapturePage } from "@/lib/pdf-anchor-capture";
import { resolveTargetRects } from "@/lib/pdf-anchor-resolve";
import { quadsTopY, type PdfTarget } from "@/lib/pdf-anchor";
import { PDFJS_VERSION } from "@/lib/pdfjs-client";
import type { PdfTextItemLike } from "@/lib/pdf-text";
import styles from "./PdfAnnotations.module.css";

// PLAN.md §19 Phase 3 — the seam between the viewer (imperative, pdfjs-owned)
// and the annotation tree (React, server-fed).
//
// It owns three things the two halves can't own separately: the live
// `PdfViewerHandle`, the `.annoLayer` lifecycle, and the "a selection is
// waiting to become an annotation" state that the popover raises and the panel
// consumes.

/** Matches the doc side's rail breakpoint, so one number governs both surfaces. */
const POSITIONED_MEDIA_QUERY = "(min-width: 1200px)";

type Props = {
  fileId: string;
  fileUrl: string;
  title: string;
  entries: PdfAnnotationEntry[];
};

export default function PdfAnnotationSurface({ fileId, fileUrl, title, entries }: Props) {
  const handleRef = useRef<PdfViewerHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [positioned, setPositioned] = useState(false);
  // The captured selection waiting to become an annotation, plus a token that
  // changes on every capture. The token is what remounts the composer: two
  // successive selections can be *equal* by value (re-selecting the same
  // phrase), so the target alone can't distinguish "a new capture" from "the
  // same one re-rendered".
  const [pending, setPending] = useState<{ target: PdfTarget; key: number } | null>(null);
  const [popover, setPopover] = useState<{ left: number; top: number; target: PdfTarget } | null>(null);

  // Subscribers that want to hear "the rendering moved" — the panel's layout
  // hook, today. A plain listener set rather than React state: this fires on
  // every scroll frame, and bumping state would re-render every card in the
  // panel to reposition cards that are moved imperatively anyway (the same
  // reasoning MarginNotesProvider gives for its own subscribe).
  const listenersRef = useRef(new Set<() => void>());
  const notify = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia(POSITIONED_MEDIA_QUERY);
    const apply = () => setPositioned(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  // Mirrored into a ref so the imperative callbacks below (which pdfjs invokes
  // long after render, on its own events) always read the current set without
  // being re-created — and therefore without tearing down and re-attaching the
  // layer on every server refresh.
  //
  // Synced in an effect rather than during render: writing a ref while
  // rendering is a real hazard, not just a lint rule (React may discard and
  // re-run a render, leaving the ref describing a tree that was never
  // committed). Declared *before* the layer effect so it has already run by the
  // time that one attaches.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  // Set by the layer effect below; called when the annotation set changes so
  // the highlights follow a post or a delete without waiting for a scroll.
  const layerRedrawRef = useRef<(() => void) | null>(null);

  const onReady = useCallback((handle: PdfViewerHandle) => {
    handleRef.current = handle;
    setReady(true);
  }, []);

  // ---- the highlight layer ------------------------------------------------
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle) return;

    const layers = attachAnnoLayers(handle.viewer, handle.eventBus, {
      entriesForPage: (pageIndex) =>
        entriesRef.current
          .filter((entry) => entry.target?.pageIndex === pageIndex)
          .map((entry): AnnoLayerEntry => ({ id: entry.root.id, target: entry.target!, color: entry.color })),
    });

    layerRedrawRef.current = layers.redraw;

    const detachClicks = attachAnnoClicks(handle.container, (ids) => {
      // Topmost wins. Overlapping annotations are normal (docs/PDF.md §7
      // offers a disambiguation menu as the richer answer); scrolling the
      // first into view in the panel is the useful minimum.
      const card = document.querySelector<HTMLElement>(`[data-margin-note-id="${CSS.escape(ids[0])}"]`);
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    // The panel repositions on the same events the layer redraws on.
    const onMoved = () => notify();
    handle.eventBus.on("updateviewarea", onMoved);
    handle.eventBus.on("pagerendered", onMoved);
    handle.eventBus.on("scalechanging", onMoved);
    handle.eventBus.on("rotationchanging", onMoved);
    handle.container.addEventListener("scroll", onMoved, { passive: true });

    return () => {
      layerRedrawRef.current = null;
      layers.destroy();
      detachClicks();
      handle.eventBus.off("updateviewarea", onMoved);
      handle.eventBus.off("pagerendered", onMoved);
      handle.eventBus.off("scalechanging", onMoved);
      handle.eventBus.off("rotationchanging", onMoved);
      handle.container.removeEventListener("scroll", onMoved);
    };
  }, [ready, notify]);

  // Redraw when the annotation set changes (a post, a delete, a refresh).
  // Runs after the ref sync above, so the layer reads the new set.
  useEffect(() => {
    layerRedrawRef.current?.();
    notify();
  }, [entries, notify]);

  // ---- selection capture --------------------------------------------------
  const capturePageFor = useCallback(async (pageIndex: number): Promise<CapturePage | null> => {
    const handle = handleRef.current;
    if (!handle) return null;
    const pageView = handle.viewer.getPageView(pageIndex) as
      | { div?: HTMLElement; viewport?: CapturePage["viewport"] }
      | undefined;
    if (!pageView?.div || !pageView.viewport) return null;

    // Text content comes from pdfjs, never from the rendered text layer —
    // docs/PDF.md §11's trap, where Hypothesis captured a placeholder's own
    // text into a selector.
    const page = await handle.pdf.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const textItems: PdfTextItemLike[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      textItems.push({
        str: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height,
        hasEOL: item.hasEOL,
      });
    }
    return { pageIndex, div: pageView.div, viewport: pageView.viewport, textItems };
  }, []);

  useEffect(() => {
    if (!ready) return;

    const onSelectionSettled = async () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPopover(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const pageElement = (range.startContainer.parentElement as HTMLElement | null)?.closest<HTMLElement>(".page");
      const pageNumber = Number(pageElement?.dataset.pageNumber);
      if (!pageElement || !Number.isInteger(pageNumber)) {
        setPopover(null);
        return;
      }

      const page = await capturePageFor(pageNumber - 1);
      if (!page) return;
      const target = captureTextTarget(page, range, PDFJS_VERSION);
      if (!target) {
        setPopover(null);
        return;
      }

      // Anchored to the end of the selection, in viewport coordinates, so the
      // control appears where the reader's pointer finished rather than over
      // the text they just read.
      const rects = Array.from(range.getClientRects());
      const last = rects[rects.length - 1];
      if (!last) return;
      setPopover({ left: last.right, top: last.bottom + 6, target });
    };

    // `selectionchange` fires per character as a drag proceeds; capturing on
    // *pointerup* instead means one capture per selection rather than one per
    // pixel of drag, and the text extraction behind it is a worker round trip.
    const onPointerUp = () => {
      // A tick, so the selection the browser reports is the finished one.
      window.setTimeout(() => void onSelectionSettled(), 0);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, [ready, capturePageFor]);

  // ---- where each card wants to sit ---------------------------------------
  const resolveTops = useCallback(() => {
    const handle = handleRef.current;
    const tops = new Map<string, number>();
    if (!handle) return tops;

    for (const entry of entriesRef.current) {
      const target = entry.target;
      if (!target) continue;
      const pageView = handle.viewer.getPageView(target.pageIndex) as
        | { div?: HTMLElement; viewport?: Parameters<typeof resolveTargetRects>[1] }
        | undefined;
      // No page view means pdfjs has evicted (or not yet built) this page, so
      // the annotation has no on-screen position — which is the normal state
      // for most of them, not an error.
      if (!pageView?.div || !pageView.viewport) continue;
      const rects = resolveTargetRects(target, pageView.viewport);
      if (rects.length === 0) continue;
      const pageRect = pageView.div.getBoundingClientRect();
      // Viewport space, matching what the layout hook subtracts its container's
      // own rect from.
      tops.set(entry.root.id, pageRect.top + Math.min(...rects.map((r) => r.top)));
    }
    return tops;
  }, []);

  const jumpTo = useCallback((entry: PdfAnnotationEntry) => {
    const handle = handleRef.current;
    if (!handle || !entry.target) return;
    const top = quadsTopY(entry.target.quads);
    handle.viewer.scrollPageIntoView({
      pageNumber: entry.target.pageIndex + 1,
      // A PDF destination array — the same shape PDF.js consumes for a link,
      // and the same one presence uses to follow a reader (docs/PDF.md §9).
      // `null` for zoom preserves the local reader's own zoom.
      destArray: [entry.target.pageIndex, { name: "XYZ" }, 0, top ?? 0, null],
    });
  }, []);

  const panel = useMemo(
    () => (
      <PdfAnnotationPanel
        fileId={fileId}
        entries={entries}
        resolveTops={resolveTops}
        subscribe={subscribe}
        positioned={positioned}
        onJumpTo={jumpTo}
        pendingTarget={pending?.target ?? null}
        pendingKey={pending?.key ?? 0}
      />
    ),
    [fileId, entries, resolveTops, subscribe, positioned, jumpTo, pending],
  );

  return (
    // DocPresenceProvider is here because LiveAnnotationComposer publishes
    // "who's composing" into it and throws without one. Its awareness stays
    // null until Phase 4 supplies a connection, which the composer already
    // handles — the doc reading view has the same null window before its own
    // provider connects.
    <DocPresenceProvider>
      <AnnotationMoveProvider>
        <PdfViewer
          fileUrl={fileUrl}
          title={title}
          onReady={onReady}
          panel={panel}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((open) => !open)}
        />

        {popover && (
          <div className={styles.selectionPopover} style={{ left: popover.left, top: popover.top }}>
            <button
              type="button"
              onClick={() => {
                setPending((previous) => ({ target: popover.target, key: (previous?.key ?? 0) + 1 }));
                setPopover(null);
                setPanelOpen(true);
                // Clearing the selection stops the highlight-under-highlight
                // confusion once the composer opens with the same passage
                // quoted in it.
                window.getSelection()?.removeAllRanges();
              }}
            >
              Annotate
            </button>
          </div>
        )}
      </AnnotationMoveProvider>
    </DocPresenceProvider>
  );
}
