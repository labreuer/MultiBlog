"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PDFJS_VERSION, documentOptions, ensurePdfWorker, pdfjs, pdfjsViewer } from "@/lib/pdfjs-client";
import { buildPageOffsets, type PageOffsets } from "@/lib/pdf-geometry";
import "pdfjs-dist/web/pdf_viewer.css";
import styles from "./PdfViewer.module.css";

// PLAN.md §19 Phase 2 — the viewer shell.
//
// Everything pdfjs owns here is imperative and lives outside React state on
// purpose. `PDFViewer` builds, renders and *evicts* page DOM itself
// (docs/PDF.md §6: it virtualises, so a page outside its buffer has no DOM at
// all), so React must never try to own children of the viewer element. What
// React owns is the chrome around it and the small amount of state the chrome
// displays.
//
// This component is loaded through `next/dynamic` with `ssr: false` by
// src/app/pdf/[slug]/PdfViewerClient.tsx — pdfjs touches `DOMMatrix` and
// `Path2D` at module scope, neither of which exists in Node.

export type PdfViewerHandle = {
  viewer: InstanceType<typeof pdfjsViewer.PDFViewer>;
  eventBus: InstanceType<typeof pdfjsViewer.EventBus>;
  pdf: pdfjs.PDFDocumentProxy;
  offsets: PageOffsets;
  container: HTMLDivElement;
};

/** One tab in the side panel, and the pane it selects. */
export type PdfPane = {
  /** Stable id; also part of the tab's and the pane's DOM ids, which
      `aria-controls`/`aria-labelledby` pair up. */
  value: string;
  /** The tab's text, and the pane's accessible name. */
  label: string;
  content: ReactNode;
};

/**
 * The "show the side panel" glyph: a pane outline with the right section
 * divided off, filled while the panel is open.
 *
 * **The fill tracks state rather than naming the target.** A fixed glyph would
 * make the button say "side panel" and leave `aria-pressed` as the only thing
 * saying whether there is one, which is invisible to everyone not using a
 * screen reader. Drawn rather than lettered because the toolbar's other glyphs
 * are all directional or rotational and there is no character for this.
 *
 * `currentColor` throughout, so it inherits `.toolbar button`'s color and needs
 * no token of its own (STYLE.md: no color literals in src/).
 */
function SidePanelIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
      {/* Inset by half the stroke width so the fill sits inside the outline
          rather than straddling it, and re-rounded on the right to follow the
          rect's own `rx`. */}
      {open && <path d="M10 3.1 H12.5 A1.4 1.4 0 0 1 13.9 4.5 V11.5 A1.4 1.4 0 0 1 12.5 12.9 H10 Z" fill="currentColor" />}
    </svg>
  );
}

type Props = {
  /** The download route's URL, hash included so it is immutable and cacheable. */
  fileUrl: string;
  title: string;
  /**
   * Called once the document is open and the first page has been laid out.
   * Everything anchoring- and presence-related hangs off this rather than off
   * props, because those features drive pdfjs imperatively too.
   */
  onReady?: (handle: PdfViewerHandle) => void;
  /**
   * The side panel's tabs, in order. Absent until Phase 3.
   *
   * **Every pane stays mounted; only the selected one is displayed.** The same
   * fact PdfAnnotationPanel's header records about individual cards holds for
   * the panel as a whole: a hidden card can be holding an open reply composer,
   * which is a live Hocuspocus connection and a DRAFT row, so changing tabs —
   * or closing the panel — must hide the annotations rather than unmount them.
   */
  panes?: PdfPane[];
  /** The selected tab's `value`. */
  activePane?: string;
  onSelectPane?: (value: string) => void;
  /** Whether the panel is showing at all — what the toolbar's icon toggles. */
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  /** Rendered in the left presence rail slot. Absent until Phase 4. */
  presenceRail?: ReactNode;
  /** Rendered in the right indicator strip slot. Absent until Phase 4. */
  indicatorStrip?: ReactNode;
  /** The presence/follow control, rendered in the toolbar. Absent until Phase 4. */
  followBar?: ReactNode;
};

const ZOOM_PRESETS = ["page-fit", "page-width", "0.5", "0.75", "1", "1.25", "1.5", "2", "3"] as const;

export default function PdfViewer({
  fileUrl,
  title,
  onReady,
  panes = [],
  activePane,
  onSelectPane,
  panelOpen = true,
  onTogglePanel,
  presenceRail,
  indicatorStrip,
  followBar,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElementRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PdfViewerHandle | null>(null);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  });

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoom, setZoom] = useState<string>("page-width");

  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (!container || !viewerElement) return;

    ensurePdfWorker();

    let cancelled = false;
    const eventBus = new pdfjsViewer.EventBus();
    const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
    const viewer = new pdfjsViewer.PDFViewer({ container, viewer: viewerElement, eventBus, linkService });
    linkService.setViewer(viewer);

    // Coalesced to one rAF tick before anything reads it: docs/PDF.md §8 notes
    // Mozilla's own tracker recording over a thousand `updateviewarea` fires
    // while scrolling a short document. Presence throttles again on top of
    // this (Phase 4); the page-number readout only needs the latest value.
    let frame = 0;
    const onViewArea = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (cancelled) return;
        setPageNumber(viewer.currentPageNumber);
        setPageDraft(String(viewer.currentPageNumber));
      });
    };
    eventBus.on("updateviewarea", onViewArea);
    eventBus.on("pagechanging", onViewArea);

    // **Registered before `setDocument`, not after the awaits below.**
    // `pagesinit` fires almost immediately once the document is handed over,
    // and the page-dimension fetch afterwards is a few worker round trips — so
    // attaching this listener inside that `.then()` reliably misses the event.
    // The viewer then renders perfectly while never reporting ready, which
    // silently disables everything downstream of `onReady` (selection capture,
    // the annotation layer) with no error anywhere.
    //
    // Readiness needs *both* signals, so each records itself and the last one
    // to arrive completes: `pagesinit` for the layout, the dimension table for
    // the geometry every rail is computed against.
    let pagesReady = false;
    let pending: PdfViewerHandle | null = null;

    const completeReady = () => {
      if (!pagesReady || !pending || cancelled) return;
      // Settable only once the first page has been laid out; assigning earlier
      // is silently dropped and the viewer opens at some default.
      viewer.currentScaleValue = "page-width";
      handleRef.current = pending;
      setStatus("ready");
      onReadyRef.current?.(pending);
    };

    const onPagesInit = () => {
      pagesReady = true;
      completeReady();
    };
    eventBus.on("pagesinit", onPagesInit);

    const task = pdfjs.getDocument(documentOptions(fileUrl));

    task.promise
      .then(async (pdf) => {
        if (cancelled) {
          // The *task*, not the proxy: PDFDocumentProxy has no destroy() in
          // pdfjs 6 (it has cleanup(), which only drops cached fonts and leaves
          // the worker alive). Same trap as src/lib/pdf-extract.ts's teardown.
          await task.destroy().catch(() => {});
          return;
        }
        viewer.setDocument(pdf);
        linkService.setDocument(pdf, null);
        setPageCount(pdf.numPages);

        // The cumulative offset table, built once from the *public* per-page
        // viewport API rather than from PDFViewer's own page list — see
        // buildPageOffsets' note on why the internal one is the wrong source.
        // Fetched in parallel: getPage is a worker round trip apiece, and a
        // 300-page document would otherwise spend a visible moment here.
        const heights = await Promise.all(
          Array.from({ length: pdf.numPages }, async (_, i) => {
            const page = await pdf.getPage(i + 1);
            const height = page.getViewport({ scale: 1 }).height;
            page.cleanup();
            return height;
          }),
        );
        if (cancelled) return;

        pending = { viewer, eventBus, pdf, offsets: buildPageOffsets(heights), container };
        completeReady();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[PdfViewer] couldn't open the document:", err);
        setErrorMessage(err instanceof Error ? err.message : "This PDF couldn't be opened.");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      eventBus.off("updateviewarea", onViewArea);
      eventBus.off("pagechanging", onViewArea);
      eventBus.off("pagesinit", onPagesInit);
      handleRef.current = null;
      // Order matters: drop the viewer's reference to the document before
      // destroying the loading task, or pdfjs renders into a document it no
      // longer has.
      //
      // `null` is the implementation's own reset path — PDFViewer.setDocument
      // begins `if (this._pdfDocument) this.#reset(); if (!pdfDocument) return;`
      // — but its generated .d.ts declares the parameter non-nullable. The cast
      // asserts what the code does rather than what the JSDoc says; passing
      // anything else (or skipping the call) leaks the page views.
      viewer.setDocument(null as unknown as pdfjs.PDFDocumentProxy);
      linkService.setDocument(null);
      task.destroy().catch(() => {});
    };
  }, [fileUrl]);

  const goToPage = useCallback((next: number) => {
    const handle = handleRef.current;
    if (!handle) return;
    const clamped = Math.max(1, Math.min(handle.pdf.numPages, Math.floor(next)));
    handle.viewer.currentPageNumber = clamped;
  }, []);

  const applyZoom = useCallback((value: string) => {
    const handle = handleRef.current;
    setZoom(value);
    if (!handle) return;
    // `currentScaleValue` takes both the named modes and a numeric string, so
    // one setter covers the whole dropdown.
    handle.viewer.currentScaleValue = value;
  }, []);

  // Arrow-key movement across the tab strip, which a row of <button>s does not
  // get for free. **Focus follows selection** (the "automatic activation"
  // tablist pattern) rather than waiting for Enter: every pane is already
  // mounted, so selecting one loads nothing and there is nothing to protect a
  // reader from doing by accident.
  const tabsRef = useRef<HTMLDivElement>(null);
  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = panes.findIndex((pane) => pane.value === activePane);
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % panes.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + panes.length) % panes.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = panes.length - 1;
    else return;
    event.preventDefault();
    onSelectPane?.(panes[next].value);
    tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  const rotate = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    // Normalised to 0..270: pdfjs accepts any multiple of 90 but reports what
    // it was given, and an ever-growing number would eventually read oddly in
    // anything that logs it.
    handle.viewer.pagesRotation = (handle.viewer.pagesRotation + 90) % 360;
  }, []);

  return (
    <div className={styles.shell} data-pdf-viewer data-pdfjs-version={PDFJS_VERSION}>
      <div className={styles.toolbar}>
        <span className={styles.title}>{title}</span>

        <button type="button" onClick={() => goToPage(pageNumber - 1)} disabled={pageNumber <= 1} aria-label="Previous page">
          ‹
        </button>
        <label>
          <span className="sr-only">Page</span>
          <input
            className={styles.pageInput}
            value={pageDraft}
            aria-label="Page number"
            onChange={(event) => setPageDraft(event.target.value)}
            onBlur={() => goToPage(Number(pageDraft) || pageNumber)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToPage(Number(pageDraft) || pageNumber);
              }
            }}
          />
        </label>
        <span className={styles.pageCount}>of {pageCount || "…"}</span>

        <button type="button" onClick={() => goToPage(pageNumber + 1)} disabled={pageCount > 0 && pageNumber >= pageCount} aria-label="Next page">
          ›
        </button>

        <label>
          <span className="sr-only">Zoom</span>
          <select value={zoom} aria-label="Zoom" onChange={(event) => applyZoom(event.target.value)}>
            {ZOOM_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset === "page-fit" ? "Fit page" : preset === "page-width" ? "Fit width" : `${Number(preset) * 100}%`}
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={rotate} aria-label="Rotate">
          ⟳
        </button>

        {followBar}

        {/* The toolbar answers only "is there a panel"; *which* pane is the
            panel's own business and lives on the tabs inside it. Splitting it
            that way keeps this row a row of document controls — page, zoom,
            rotate — rather than a place that also names the panel's contents,
            and it means adding a fourth pane later touches nothing here. */}
        {panes.length > 0 && onTogglePanel && (
          <button
            type="button"
            className={styles.panelToggle}
            onClick={onTogglePanel}
            aria-pressed={panelOpen}
            aria-label={panelOpen ? "Hide the side panel" : "Show the side panel"}
            title={panelOpen ? "Hide the side panel" : "Show the side panel"}
          >
            <SidePanelIcon open={panelOpen} />
          </button>
        )}
      </div>

      <div className={styles.body}>
        {presenceRail}

        <div className={styles.viewerWrap}>
          {/* pdfjs requires exactly this nesting: an absolutely positioned,
              scrollable container holding one `.pdfViewer` element it owns
              outright. Nothing React renders may go inside that element. */}
          <div ref={containerRef} className={styles.viewerContainer} data-pdf-container>
            <div ref={viewerElementRef} className="pdfViewer" />
          </div>
          {status === "loading" && <p className={styles.status}>Loading…</p>}
          {status === "error" && <p className={styles.error}>{errorMessage}</p>}
        </div>

        {indicatorStrip}

        {panes.length > 0 && (
          <div className={`${styles.panelColumn} ${panelOpen ? styles.panelColumnOpen : ""}`}>
            {/* The strip is a sibling *above* the panes, never a child of one —
                `.panel` is the scroller and the box use-pdf-margin-notes.ts
                measures a card's `targetTop` against, so anything inserted
                between the two shifts every card by its own height. The
                stylesheet carries the long version. */}
            <div ref={tabsRef} className={styles.tabs} role="tablist" aria-label="Side panel" onKeyDown={moveTab}>
              {panes.map((pane) => (
                <button
                  key={pane.value}
                  id={`pdf-tab-${pane.value}`}
                  type="button"
                  role="tab"
                  aria-selected={pane.value === activePane}
                  aria-controls={`pdf-pane-${pane.value}`}
                  // Roving tabindex: a tablist is one tab stop, and the arrow
                  // keys move within it (see moveTab).
                  tabIndex={pane.value === activePane ? 0 : -1}
                  className={`${styles.tab} ${pane.value === activePane ? styles.tabActive : ""}`}
                  onClick={() => onSelectPane?.(pane.value)}
                >
                  {pane.label}
                </button>
              ))}
            </div>

            {/* Each pane its own `.panel`, all of them mounted, only the
                selected one displayed — the `panes` prop above says why the
                mounting is load-bearing. */}
            {panes.map((pane) => (
              <div
                key={pane.value}
                id={`pdf-pane-${pane.value}`}
                role="tabpanel"
                aria-labelledby={`pdf-tab-${pane.value}`}
                className={`${styles.panel} ${pane.value === activePane ? styles.panelOpen : ""}`}
              >
                {pane.content}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
