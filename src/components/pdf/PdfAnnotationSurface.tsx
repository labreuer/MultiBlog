"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import PdfViewer, { type PdfPane, type PdfViewerHandle } from "./PdfViewer";
import PdfAnnotationPanel, { entryHasVisibleContent, type PdfAnnotationEntry } from "./PdfAnnotationPanel";
import PdfMetadataPanel from "./PdfMetadataPanel";
import PdfCollabPanel from "./PdfCollabPanel";
import { loadPdfAnnotationEntries } from "@/app/actions/annotations";
import { AnnotationReloadProvider } from "@/components/annotation/annotation-reload-context";
import { attachAnnoClicks, attachAnnoLayers, type AnnoLayerEntry } from "./anno-layer";
import { usePdfPresence } from "./use-pdf-presence";
import { PdfFollowBar, PdfIndicatorStrip, PdfPresenceRail, type AnnotationTick } from "./PdfRails";
import {
  JUMP_VIEWPORT_FRACTION,
  documentFraction,
  jumpDestinationY,
  visibleFractionRange,
} from "@/lib/pdf-geometry";
import { captureTextTarget, type CapturePage } from "@/lib/pdf-anchor-capture";
import { resolveTargetRects } from "@/lib/pdf-anchor-resolve";
import { quadsTopY, type PdfTarget } from "@/lib/pdf-anchor";
import { fixedPlacementStyle } from "@/lib/popover-placement";
import type { RemoteReader } from "./use-pdf-presence";
import { PDFJS_VERSION, pdfjs } from "@/lib/pdfjs-client";
import type { PdfTextItemLike } from "@/lib/pdf-text";
import styles from "./PdfAnnotations.module.css";

// PLAN.md §19 Phase 3 — the seam between the viewer (imperative, pdfjs-owned)
// and the annotation tree (React, server-fed).
//
// It owns three things the two halves can't own separately: the live
// `PdfViewerHandle`, the `.annoLayer` lifecycle, and the "a selection is
// waiting to become an annotation" state that the popover raises and the panel
// consumes.

// Deliberately *not* the doc side's 1180px rail breakpoint (that's an 800px
// reading column + a 340px rail's own math, src/lib/margin-notes-layout.ts).
// This panel is a fixed-width card list beside a viewer that has nothing to
// reflow, not a rail that needs room for live prose — so it can go narrower.
// 768px is the narrowest common iPad width (Mini, portrait); every iPad in
// landscape is wider than its own portrait width, so this covers both.
const POSITIONED_MEDIA_QUERY = "(min-width: 768px)";

// The side panel's tab ids. Plain strings rather than an enum because they are
// also half of each tab's and pane's DOM id, which `aria-controls` pairs up.
const ANNOTATIONS_PANE = "annotations";
const METADATA_PANE = "metadata";
const COLLAB_PANE = "collab";

// How long a selection has to stop changing before it's captured. Matches
// AnnotationNode's constant of the same name, for the same reason: a drag emits
// a selection update per pixel, and each capture behind this one is a pdfjs
// worker round trip.
const SELECTION_SETTLE_MS = 300;

type Props = {
  fileId: string;
  fileUrl: string;
  title: string;
  entries: PdfAnnotationEntry[];
  /**
   * The Metadata pane's contents, rendered on the *server* and handed in as a
   * prop — see PdfSurfaceClient's header for why it can't be imported here.
   */
  metadata: ReactNode;
};

export default function PdfAnnotationSurface({ fileId, fileUrl, title, entries, metadata }: Props) {
  const handleRef = useRef<PdfViewerHandle | null>(null);
  const [ready, setReady] = useState(false);
  // Two separate questions, and the UI asks them in two places: the toolbar's
  // icon says whether there is a panel at all, the tabs inside it say which
  // pane. Keeping them apart is what lets closing and reopening the panel come
  // back to the tab you were on.
  const [panelOpen, setPanelOpen] = useState(true);
  const [activePane, setActivePane] = useState(ANNOTATIONS_PANE);
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
  // PLAN.md §19 — what this surface renders: the server's list, until a post
  // gives us a fresher one.
  //
  // **A posted annotation cannot reach the panel through `router.refresh()`
  // alone here.** That refresh is a React *transition*, and this whole surface
  // sits behind `next/dynamic({ ssr: false })` — a Suspense boundary. During a
  // transition React keeps showing the old UI rather than dropping to a
  // fallback, so a refresh that doesn't commit promptly is completely silent:
  // no error, no spinner, no console line, just a panel still reading "No
  // annotations yet" while a fully parsed payload sits on the client. Measured
  // against a production build on one worker: ~50% of posts had not rendered
  // 2.5s later and ~25% were still missing at 15s, with the page *idle* — zero
  // scroll events, zero DOM mutations — and any unrelated click rendering them
  // at once. docs/playwright-flakiness.html carries the forensics.
  //
  // So the composer says it posted and we ask the server ourselves. This fetch
  // is ours: we know when it lands, and nothing about it can be deprioritised.
  // `router.refresh()` still runs underneath — it is what reconciles the rest
  // of the page — and the effect below stands down the moment it does, so the
  // server prop stays the single source of truth rather than this becoming a
  // parallel one.
  // The local copy remembers **which `entries` it was fetched against**, and is
  // used only while that is still the prop in hand. So a refresh landing later
  // supersedes it by simply existing — no effect resetting state, no window
  // where the two disagree, and no way for this to become a second source of
  // truth that outlives its usefulness.
  const [refetched, setRefetched] = useState<{ base: PdfAnnotationEntry[]; list: PdfAnnotationEntry[] } | null>(null);
  const liveEntries = refetched?.base === entries ? refetched.list : entries;

  const reloadEntries = useCallback(() => {
    const base = entries;
    loadPdfAnnotationEntries(fileId)
      .then((list) => setRefetched({ base, list }))
      // Deliberately quiet, and deliberately not an empty list: the panel keeps
      // whatever it is already showing. The annotation is written either way —
      // this only decides how soon it is drawn — so the worst a failure here
      // costs is the wait this exists to remove.
      .catch(() => {});
  }, [fileId, entries]);

  const entriesRef = useRef(liveEntries);
  useEffect(() => {
    entriesRef.current = liveEntries;
  }, [liveEntries]);

  // Set by the layer effect below; called when the annotation set changes so
  // the highlights follow a post or a delete without waiting for a scroll.
  const layerRedrawRef = useRef<(() => void) | null>(null);

  // Held in state as well as in the ref: the rails are React and need the
  // offsets table to re-render against, where the imperative callbacks need the
  // stable ref.
  const [handle, setHandle] = useState<PdfViewerHandle | null>(null);
  const onReady = useCallback((next: PdfViewerHandle) => {
    handleRef.current = next;
    setHandle(next);
    setReady(true);
  }, []);

  const presence = usePdfPresence(fileId, handle);

  // Same mirroring, for the same reason: the layer's callbacks are invoked by
  // pdfjs long after render and must see the current readers without the layer
  // being re-attached every time somebody scrolls.
  // Read by the selection effect, which must not re-attach its document-level
  // listener every time somebody else scrolls.
  const presenceRef = useRef(presence);
  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

  const readersRef = useRef(presence.readers);
  useEffect(() => {
    readersRef.current = presence.readers;
    layerRedrawRef.current?.();
  }, [presence.readers]);

  // The visible slab, as a 0..1 range, recomputed on the same "rendering moved"
  // signal everything else here uses.
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number } | null>(null);
  const [railHeight, setRailHeight] = useState(0);

  // ---- the highlight layer ------------------------------------------------
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle) return;

    const layers = attachAnnoLayers(handle.viewer, handle.eventBus, {
      entriesForPage: (pageIndex) =>
        entriesRef.current
          // entryHasVisibleContent, not just a page match: a soft-deleted
          // thread must take its highlight with it.
          .filter((entry) => entry.target?.pageIndex === pageIndex && entryHasVisibleContent(entry))
          .map((entry): AnnoLayerEntry => ({ id: entry.root.id, target: entry.target!, color: entry.color })),
      // PLAN.md §19 — other readers' live selections, drawn in the same layer
      // and with the same filled highlight an annotation gets, in that
      // reader's own colour. They appear for whichever pages are rendered,
      // which is exactly "show it if it would be visible on this reader's
      // view" without needing to compute that separately.
      remoteForPage: (pageIndex) =>
        readersRef.current
          .filter((reader) => reader.presence.selection?.pageIndex === pageIndex)
          .map((reader): AnnoLayerEntry => ({
            id: `remote-${reader.clientId}`,
            color: reader.presence.user.color,
            target: {
              pageIndex,
              quads: reader.presence.selection!.quads,
              quote: { exact: "", prefix: "", suffix: "" },
              position: null,
              textVersion: "",
            },
          })),
    });

    layerRedrawRef.current = layers.redraw;

    const detachClicks = attachAnnoClicks(handle.container, (ids) => {
      // Topmost wins. Overlapping annotations are normal (docs/PDF.md §7
      // offers a disambiguation menu as the richer answer); scrolling the
      // first into view in the panel is the useful minimum.
      const card = document.querySelector<HTMLElement>(`[data-margin-note-id="${CSS.escape(ids[0])}"]`);
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    // The panel repositions — and the right-hand strip's thumb moves — on the
    // same events the layer redraws on.
    const onMoved = () => {
      notify();
      const containerRect = handle.container.getBoundingClientRect();
      const top = fractionAtViewportY(handle, containerRect.top);
      const bottom = fractionAtViewportY(handle, containerRect.bottom);
      setVisibleRange(top && bottom ? visibleFractionRange(handle.offsets, top, bottom) : null);
    };
    handle.eventBus.on("updateviewarea", onMoved);
    handle.eventBus.on("pagerendered", onMoved);
    handle.eventBus.on("scalechanging", onMoved);
    handle.eventBus.on("rotationchanging", onMoved);
    handle.container.addEventListener("scroll", onMoved, { passive: true });
    onMoved();

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
  //
  useEffect(() => {
    layerRedrawRef.current?.();
    notify();
  }, [liveEntries, notify]);

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

    // Two triggers plus a debounce means a run can still be awaiting
    // `capturePageFor` when the next one starts — dragging an iOS selection
    // handle emits a `selectionchange` per pixel of drag. Each run claims a
    // generation and drops its own results if a newer one has started, so an
    // older capture finishing late can't publish over a newer selection.
    let generation = 0;

    const onSelectionSettled = async () => {
      const run = ++generation;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPopover(null);
        presenceRef.current?.publishSelection(null);
        return;
      }
      // Cloned, because `getRangeAt` hands back the *live* range: left as-is it
      // would mutate under the await below, and the rects measured for the
      // popover would then describe a different selection than the one captured.
      const range = selection.getRangeAt(0).cloneRange();
      const pageElement = (range.startContainer.parentElement as HTMLElement | null)?.closest<HTMLElement>(".page");
      const pageNumber = Number(pageElement?.dataset.pageNumber);
      if (!pageElement || !Number.isInteger(pageNumber)) {
        setPopover(null);
        // Clearing, not just returning: awareness is *sticky*, so a selection
        // that isn't in the PDF still has to retract the one that was. The
        // collapsed branch above cannot cover this — there is a real selection
        // here, just not on a page — and reaching it is routine rather than
        // exceptional, because selecting text inside a posted annotation is the
        // gesture that anchors a reply to it (AnnotationNode renders bodies
        // through AnnotationBodyReader for exactly that). Without this, a
        // reader who highlights a passage and then goes to reply in the panel
        // leaves that highlight burning on everyone else's view until some
        // later click happens to collapse the selection.
        presenceRef.current?.publishSelection(null);
        return;
      }

      // Guarded, because everything behind it is pdfjs: a worker round trip
      // and a parse of somebody's arbitrary PDF. A rejection here used to
      // surface as an unhandledRejection and take the capture with it — which
      // is exactly how the WebKit ReadableStream gap presented on an iPad
      // (src/lib/pdfjs-webkit-polyfills.ts): a selection captured, then
      // silently dropped, indistinguishable from the trigger never firing.
      // Failing closed keeps the surface usable — no popover, no stale
      // broadcast — rather than leaving a dead listener behind.
      let page: CapturePage | null;
      try {
        page = await capturePageFor(pageNumber - 1);
      } catch (error) {
        console.warn("[pdf] couldn't read the page's text to anchor this selection:", error);
        setPopover(null);
        presenceRef.current?.publishSelection(null);
        return;
      }
      if (!page || run !== generation) return;
      const target = captureTextTarget(page, range, PDFJS_VERSION);
      if (!target) {
        setPopover(null);
        // Same rule as the page lookup above, for the rarer shape of the same
        // thing: the selection is real but has no quads on this page (every
        // rect zero-area, or the selection falling in the gap between two
        // pages), so what was broadcast before is now wrong and has to be
        // retracted rather than left standing.
        presenceRef.current?.publishSelection(null);
        return;
      }

      // Broadcast it, so other readers see what this one is looking at even if
      // it never becomes an annotation. Ephemeral by construction — it lives in
      // awareness and disappears when the selection or the connection does.
      presenceRef.current?.publishSelection({ pageIndex: target.pageIndex, quads: target.quads });

      // Anchored to the end of the selection, in viewport coordinates, so the
      // control appears where the reader's pointer finished rather than over
      // the text they just read.
      const rects = Array.from(range.getClientRects());
      const last = rects[rects.length - 1];
      if (!last) return;
      // This control is `position: fixed`, so it goes through the same helper
      // as every other one (docs/mobile/coordinates.html) — in the handler, not at render, since the
      // probe touches the DOM. **Defensive here**, same reason as SiteHeader's
      // placePanel: the selecting tap has already dismissed any keyboard.
      const anchored = fixedPlacementStyle({ top: last.bottom + 6, left: last.right });
      setPopover({ left: anchored.left, top: anchored.top, target });
    };

    // Two triggers into one handler, because neither covers every way a
    // selection can be made:
    //
    //  - **`pointerup`** is "the drag is definitely over", so a mouse
    //    selection gets its popover immediately rather than after the settle
    //    delay. A tick, so the selection the browser reports is the finished one.
    //  - **`selectionchange`, debounced** is the one that fires for everything
    //    else. It is deliberately *not* the sole trigger on desktop — it emits
    //    per character of drag, and the capture behind it is a worker round
    //    trip — but pointerup alone cannot see a **keyboard selection
    //    (shift+arrows), which emits no pointer event on any platform.** That
    //    is the permanent reason this trigger exists.
    //
    //    Two further reasons used to be listed here — an iPadOS long-press
    //    supposedly yielding `pointercancel` rather than `pointerup`, and the
    //    selection handles supposedly being native views emitting nothing on
    //    `document`. Both were **measured false** on 2026-08-25 against a real
    //    iPhone 13 Pro (iOS 18.6.2) and iPad (iPadOS 18.6), by instrumenting 18
    //    event types in the page via scripts/remote-console.ts: a long-press
    //    ends in `pointerup` (+1375ms / +1155ms), and dragging a handle emits
    //    74-76 `pointermove`s with live coordinates, `pointercancel` never once.
    //    The cancel is real for *scrolling*, which is where the observation
    //    seems to have come from. docs/PDF.md §10 has the traces.
    //
    //    **So do not delete the pointerup branch as unreachable on touch** —
    //    it fires there, and it is what makes a touch selection settle
    //    promptly rather than after the debounce. AnnotationNode's
    //    handleBodySelect settles on a timer for the same reason.
    //
    // They share one timer rather than running independently, so a mouse drag
    // costs the same single capture it always did: the per-pixel
    // `selectionchange`s keep rescheduling, and the pointerup that ends the
    // drag supersedes the pending one instead of adding a second run.
    let settleTimer: number | undefined;
    const settle = (delay: number) => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => void onSelectionSettled(), delay);
    };
    const onPointerUp = () => settle(0);
    const onSelectionChange = () => settle(SELECTION_SETTLE_MS);

    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(settleTimer);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [ready, capturePageFor]);

  // ---- where each card wants to sit ---------------------------------------
  // Viewport-space top per annotation whose passage is **on screen right now**,
  // which is what bounds the rail: a card is only ever placed level with text
  // the reader can see, so the packed column can't grow past the panel's own
  // height however far away the next annotation is. Anything absent from this
  // map is not in the rail at all (PdfAnnotationPanel hides it), rather than
  // cascading to the end of a column that then has to be scrolled.
  //
  // "On screen" is intersection with the viewer container's own rect, not "on a
  // page pdfjs has built" — pdfjs keeps a buffer of pages above and below the
  // visible region, and those were exactly the cards that used to be placed
  // hundreds of pixels below the fold.
  const resolveTops = useCallback(() => {
    const handle = handleRef.current;
    const tops = new Map<string, number>();
    if (!handle) return tops;

    const viewRect = handle.container.getBoundingClientRect();

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
      const top = pageRect.top + Math.min(...rects.map((r) => r.top));
      const bottom = pageRect.top + Math.max(...rects.map((r) => r.top + r.height));
      // Partially visible counts: a passage half off the bottom edge still has
      // a card to sit beside, and requiring full visibility would make cards
      // flicker in and out at the edges as the reader scrolls.
      //
      // **The band is deliberately asymmetric**, extending one viewport height
      // *above* the top edge and not one pixel below the bottom. A card hangs
      // downwards from its passage, so one arriving at the bottom is already
      // gradual: it is placed below the fold and rises into view. One arriving
      // at the top had nowhere to be until it was due, so it appeared at full
      // height in the frame its passage crossed the edge. Given a lead-in it is
      // placed above the panel (clipped) or under the panel's chrome, and
      // slides out from under it instead.
      //
      // A whole viewport height rather than a card's height because this
      // function has no idea how tall a card is, and the bound has to exceed the
      // tallest one to hide it completely. It costs nothing downstream: the
      // packer cascades *downwards*, so a lead-in card placed at a negative top
      // cannot move a visible one, and the container height it reports is the
      // bottom of the last card either way. A card taller than the panel itself
      // can never be fully hidden, and still arrives partly formed.
      if (bottom <= viewRect.top - viewRect.height || top >= viewRect.bottom) continue;
      tops.set(entry.root.id, top);
    }
    return tops;
  }, []);

  // The thumb's 20px minimum is a pixel threshold, so the rail's real height
  // has to be measured. Measured off the **viewer container**, not the rail
  // element: the two are siblings in a stretched flex row and therefore the
  // same height, and the container is the one that reliably has a box. (The
  // rail is wrapped for layout reasons at the call site, and a wrapper is
  // exactly the kind of thing that can end up with no height of its own.)
  useEffect(() => {
    const container = handle?.container;
    if (!container) return;
    // No explicit initial measurement: ResizeObserver fires once on `observe`
    // with the element's current size, so a synchronous setState here would
    // only add a cascading render before the observer's own first callback.
    //
    // **clientHeight, not offsetHeight** — this is now both rails' actual
    // height, not just the input to the thumb-visibility threshold, and the
    // difference is exactly the horizontal scrollbar the vertical track also
    // loses. PdfRails.tsx's header has the measurement.
    const observer = new ResizeObserver(() => setRailHeight(container.clientHeight));
    observer.observe(container);
    return () => observer.disconnect();
  }, [handle]);

  /**
   * Scroll a passage into view, landing it `fraction` of the way down rather
   * than flush against the top edge — see JUMP_VIEWPORT_FRACTION for why.
   *
   * The caller chooses, because only it knows whether the panel's chrome is
   * over the rail: the indicator strip's ticks and a card's page badge in rail
   * mode both want the offset, while "Show all" has no positioned card to keep
   * clear of and passes 0.
   */
  const jumpTo = useCallback((entry: PdfAnnotationEntry, fraction: number = JUMP_VIEWPORT_FRACTION) => {
    const handle = handleRef.current;
    if (!handle || !entry.target) return;
    const top = quadsTopY(entry.target.quads) ?? 0;
    handle.viewer.scrollPageIntoView({
      pageNumber: entry.target.pageIndex + 1,
      // A PDF destination array — the same shape PDF.js consumes for a link,
      // and the same one presence uses to follow a reader (docs/PDF.md §9).
      // `null` for zoom preserves the local reader's own zoom.
      //
      // The scale is read at click time rather than closed over: the reader may
      // have zoomed since. `currentScale * PDF_TO_CSS_UNITS`, never the bare
      // zoom level — docs/PDF.md §5.
      destArray: [
        entry.target.pageIndex,
        { name: "XYZ" },
        0,
        jumpDestinationY(
          top,
          handle.container.clientHeight,
          handle.viewer.currentScale * pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS,
          fraction,
        ),
        null,
      ],
    });
  }, []);

  // One tick per anchored annotation, at its own document fraction.
  const ticks = useMemo((): AnnotationTick[] => {
    if (!handle) return [];
    return liveEntries.flatMap((entry) => {
      const target = entry.target;
      // Same rule as the highlight above — a deleted thread leaves no tick.
      if (!target || !entryHasVisibleContent(entry)) return [];
      const top = quadsTopY(target.quads);
      if (top === null) return [];
      const pageHeight = pageHeightAt(handle.offsets, target.pageIndex);
      // PDF user space measures y upward from the page's bottom; a document
      // fraction measures downward from its top. This subtraction is the whole
      // conversion, and it is the one place the sign flip happens for ticks.
      return [
        {
          id: entry.root.id,
          fraction: documentFraction(handle.offsets, target.pageIndex, Math.max(0, pageHeight - top)),
          color: entry.color,
          label: entry.quotedText || `Annotation on page ${target.pageIndex + 1}`,
        },
      ];
    });
  }, [liveEntries, handle]);

  const jumpToReader = useCallback((reader: RemoteReader) => {
    const current = handleRef.current;
    const viewport = reader.presence.viewport;
    if (!current || !viewport) return;
    current.viewer.scrollPageIntoView({
      pageNumber: viewport.pageIndex + 1,
      destArray: [viewport.pageIndex, { name: "XYZ" }, viewport.pdfPoint[0], viewport.pdfPoint[1], null],
    });
  }, []);

  const jumpToAnnotation = useCallback(
    (id: string) => {
      const entry = entriesRef.current.find((candidate) => candidate.root.id === id);
      if (entry) jumpTo(entry);
    },
    [jumpTo],
  );

  const panel = useMemo(
    () => (
      // Everything that can change this file's annotations renders inside
      // here — the composer, every card's Reply, every card's Delete — so one
      // provider covers all of them without a prop per path.
      <AnnotationReloadProvider reload={reloadEntries}>
        <PdfAnnotationPanel
          fileId={fileId}
          entries={liveEntries}
          resolveTops={resolveTops}
          subscribe={subscribe}
          positioned={positioned}
          onJumpTo={jumpTo}
          pendingTarget={pending?.target ?? null}
          pendingKey={pending?.key ?? 0}
          onClearPending={() => setPending(null)}
        />
      </AnnotationReloadProvider>
    ),
    [fileId, liveEntries, resolveTops, subscribe, positioned, jumpTo, pending, reloadEntries],
  );

  const panes = useMemo<PdfPane[]>(
    () => [
      { value: ANNOTATIONS_PANE, label: "Annotations", content: panel },
      { value: METADATA_PANE, label: "Metadata", content: <PdfMetadataPanel>{metadata}</PdfMetadataPanel> },
      { value: COLLAB_PANE, label: "Collab", content: <PdfCollabPanel /> },
    ],
    [panel, metadata],
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
          panes={panes}
          activePane={activePane}
          onSelectPane={setActivePane}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((open) => !open)}
          presenceRail={
            <PdfPresenceRail
              readers={presence.readers}
              offsets={handle?.offsets ?? null}
              railHeightPx={railHeight}
              onJumpTo={jumpToReader}
            />
          }
          indicatorStrip={
            <PdfIndicatorStrip
              ticks={ticks}
              visibleRange={visibleRange}
              railHeightPx={railHeight}
              onJumpTo={jumpToAnnotation}
            />
          }
          followBar={
            <PdfFollowBar
              readers={presence.readers}
              leading={presence.leading}
              onSetLeading={presence.setLeading}
              following={presence.following}
              onFollow={presence.follow}
            />
          }
        />

        {popover && (
          <div className={styles.selectionPopover} style={{ left: popover.left, top: popover.top }}>
            <button
              type="button"
              onClick={() => {
                setPending((previous) => ({ target: popover.target, key: (previous?.key ?? 0) + 1 }));
                setPopover(null);
                // Both, and neither is enough alone: the composer they just
                // asked for is in the annotations pane, which is no help if the
                // panel is closed or if they are looking at Metadata.
                setPanelOpen(true);
                setActivePane(ANNOTATIONS_PANE);
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

/** A page's height at scale 1, recovered from the cumulative offset table. */
function pageHeightAt(offsets: PdfViewerHandle["offsets"], pageIndex: number): number {
  const top = offsets.tops[pageIndex];
  if (top === undefined) return 0;
  return (offsets.tops[pageIndex + 1] ?? offsets.total) - top;
}

/**
 * Which page, and how far down it, sits at a given viewport y — the input to
 * the visible-range calculation.
 *
 * Walks the *rendered* pages rather than computing from scroll offset, because
 * only rendered pages have a box to measure and pdfjs virtualises. At the top
 * and bottom edges of a long document the answer can be null (the edge falls in
 * a gap, or on a page not yet built), which the caller treats as "no thumb"
 * rather than guessing.
 */
function fractionAtViewportY(
  handle: PdfViewerHandle,
  clientY: number,
): { pageIndex: number; yFromTop: number } | null {
  const pages = handle.container.querySelectorAll<HTMLElement>(".page");
  for (const page of pages) {
    const rect = page.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) continue;
    const pageNumber = Number(page.dataset.pageNumber);
    if (!Number.isInteger(pageNumber)) continue;
    const pageIndex = pageNumber - 1;
    const height = pageHeightAt(handle.offsets, pageIndex);
    // Scaled back to the unrotated, scale-1 space every fraction is measured
    // in — a fraction that depended on the reader's zoom would mean something
    // different to each of them, which is the whole thing this avoids.
    const fractionDownPage = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    return { pageIndex, yFromTop: fractionDownPage * height };
  }
  return null;
}
