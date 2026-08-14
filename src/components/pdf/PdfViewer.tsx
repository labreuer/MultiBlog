"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  /** Rendered into the right-hand panel column. Absent until Phase 3. */
  panel?: ReactNode;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  /** Rendered in the left presence rail slot. Absent until Phase 4. */
  presenceRail?: ReactNode;
  /** Rendered in the right indicator strip slot. Absent until Phase 4. */
  indicatorStrip?: ReactNode;
};

const ZOOM_PRESETS = ["page-fit", "page-width", "0.5", "0.75", "1", "1.25", "1.5", "2", "3"] as const;

export default function PdfViewer({
  fileUrl,
  title,
  onReady,
  panel,
  panelOpen = true,
  onTogglePanel,
  presenceRail,
  indicatorStrip,
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

        const offsets = buildPageOffsets(heights);
        const handle: PdfViewerHandle = { viewer, eventBus, pdf, offsets, container };
        handleRef.current = handle;

        // `pagesinit` fires once the first page has been laid out, which is
        // when `currentScaleValue` becomes settable — assigning it earlier is
        // silently dropped, and the viewer opens at whatever default it likes.
        const onPagesInit = () => {
          viewer.currentScaleValue = "page-width";
          setStatus("ready");
          onReadyRef.current?.(handle);
        };
        eventBus.on("pagesinit", onPagesInit);
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

        {panel && onTogglePanel && (
          <button type="button" onClick={onTogglePanel} aria-label="Toggle annotations" aria-pressed={panelOpen}>
            {panelOpen ? "Hide annotations" : "Annotations"}
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

        {panel && <aside className={`${styles.panel} ${panelOpen ? styles.panelOpen : ""}`}>{panel}</aside>}
      </div>
    </div>
  );
}
