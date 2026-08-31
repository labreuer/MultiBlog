"use client";

import type { pdfjsViewer } from "@/lib/pdfjs-client";
import { resolveTargetRects } from "@/lib/pdf-anchor-resolve";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { SAFE_COLOR } from "@/lib/safe-css";

// PLAN.md §19 / docs/PDF.md §6 — our own highlight layer, per page, beside the
// ones PDF.js owns:
//
//   .page
//     .canvasWrapper    (PDF.js)
//     .annoLayer        OURS
//     .textLayer        (PDF.js) — native selection must keep working
//     .annotationLayer  (PDF.js) — link annotations
//
// **PDF.js's own layers are never mutated** (invariant 4): it builds and
// rebuilds them, and anything we put inside would vanish on the next render or
// break selection. Our layer is a sibling, inserted before `.textLayer` so it
// paints under the selectable text, and `pointer-events: none` so it never
// intercepts a drag that starts on a highlight.
//
// Imperative, not React. PDF.js *virtualises*: a page outside its buffer has no
// DOM at all, and the elements for one that scrolls back into view are new
// nodes. React reconciliation against nodes another library creates and
// destroys is the wrong tool; this attaches on `textlayerrendered` and lets the
// page's own removal take the layer with it.

const LAYER_CLASS = "annoLayer";

export type AnnoLayerEntry = {
  /** The annotation id, written to `data-anno-id` for the delegated click handler. */
  id: string;
  target: PdfTarget;
  /** The author's color — validated through SAFE_COLOR before it reaches a style attribute. */
  color: string;
  /** Drawn more strongly; set for the annotation whose card is focused. */
  active?: boolean;
  // docs/ANCHORED_LINKS.md — an anchored-link part's region. Drawn as an
  // outline rather than a fill (the doc side's exact split: the wash is the
  // annotation family's look), and it carries **no data-anno-id**, so the
  // delegated click handler never sees it — an annotation stays clickable
  // straight through a link region above it, and a link-only region does
  // nothing on click; the ?sel= banner is its affordance.
  variant?: "link";
};

export type AnnoLayerSource = {
  /**
   * Every entry that belongs on `pageIndex`. Called on each (re)render of that
   * page. **Order is meaningful**: highlights are opaque fills flattened by one
   * group opacity (PdfAnnotations.module.css), so where two overlap the one
   * appended later wins outright rather than the two blending. Callers pass
   * annotations oldest-first, which puts the newest on top.
   */
  entriesForPage: (pageIndex: number) => AnnoLayerEntry[];
  /**
   * Live remote selections (PLAN.md §19 Phase 4). Same drawing path *and* the
   * same filled styling as an annotation — they used to be drawn as an outline
   * so they'd read as somebody's cursor, but a highlight in the reader's own
   * colour is what this surface shows now. Appended after every annotation
   * rect, so a live selection is never hidden under a saved highlight.
   */
  remoteForPage?: (pageIndex: number) => AnnoLayerEntry[];
};

/**
 * Keeps an `.annoLayer` in sync with every rendered page.
 *
 * Returns a teardown that detaches the listeners and removes the layers. The
 * caller re-runs `redraw()` whenever the annotation set changes; pdfjs's own
 * events cover everything else (a page rendering, a scale change, a rotation).
 */
export function attachAnnoLayers(
  viewer: InstanceType<typeof pdfjsViewer.PDFViewer>,
  eventBus: InstanceType<typeof pdfjsViewer.EventBus>,
  source: AnnoLayerSource,
): { redraw: () => void; destroy: () => void } {
  // Which page numbers currently have DOM. pdfjs evicts pages, so this is the
  // authoritative set — iterating 1..numPages would ask for elements that
  // aren't there.
  const rendered = new Set<number>();

  function drawPage(pageNumber: number): void {
    // `getPageView` is the supported way in; `_pages` is the internal it wraps
    // and is undefined for an evicted page.
    const pageView = viewer.getPageView(pageNumber - 1) as
      | { div?: HTMLElement; viewport?: Parameters<typeof resolveTargetRects>[1] }
      | undefined;
    const div = pageView?.div;
    const viewport = pageView?.viewport;
    if (!div || !viewport) return;

    let layer = div.querySelector<HTMLElement>(`.${LAYER_CLASS}`);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = LAYER_CLASS;
      // Inserted *before* the text layer so highlights paint underneath
      // selectable text. If the text layer hasn't been built yet, appending is
      // correct too — pdfjs inserts its own layers in order.
      const textLayer = div.querySelector(".textLayer");
      div.insertBefore(layer, textLayer ?? null);
    }

    const pageIndex = pageNumber - 1;
    // Rebuilt wholesale rather than diffed. Rects are re-derived from quads on
    // every render at the current scale and rotation (docs/PDF.md §6: never
    // cache positioned DOM across a scale change), so there is nothing worth
    // preserving between passes, and a page holds tens of rects, not thousands.
    layer.replaceChildren();

    // Append order *is* stacking order — see AnnoLayerSource. Annotations
    // first (oldest to newest), then live remote selections over the lot.
    const entries = source.entriesForPage(pageIndex);
    for (const entry of entries) {
      appendRects(layer, entry, viewport, false);
    }
    for (const entry of source.remoteForPage?.(pageIndex) ?? []) {
      appendRects(layer, entry, viewport, true);
    }
  }

  function redraw(): void {
    for (const pageNumber of rendered) drawPage(pageNumber);
  }

  // `textlayerrendered` implies the canvas is up (docs/PDF.md §6) and is the
  // point at which the page div is stable enough to hang a sibling off.
  const onTextLayer = ({ pageNumber }: { pageNumber: number }) => {
    rendered.add(pageNumber);
    drawPage(pageNumber);
  };
  // pdfjs re-renders a page's canvas on scale/rotation change without
  // necessarily rebuilding the text layer, so this is a second, independent
  // trigger rather than a duplicate of the one above.
  const onPageRendered = ({ pageNumber }: { pageNumber: number }) => {
    rendered.add(pageNumber);
    drawPage(pageNumber);
  };
  const onEvicted = ({ pageNumber }: { pageNumber: number }) => {
    // The layer went with the page's own DOM; only our bookkeeping is left.
    rendered.delete(pageNumber);
  };
  // A scale or rotation change invalidates every cached rect at once. pdfjs
  // will re-render each visible page and fire pagerendered, but redrawing
  // eagerly here avoids a frame of stale highlights at the old scale.
  const onScaleOrRotation = () => redraw();

  eventBus.on("textlayerrendered", onTextLayer);
  eventBus.on("pagerendered", onPageRendered);
  eventBus.on("pagecancelled", onEvicted);
  eventBus.on("scalechanging", onScaleOrRotation);
  eventBus.on("rotationchanging", onScaleOrRotation);

  return {
    redraw,
    destroy() {
      eventBus.off("textlayerrendered", onTextLayer);
      eventBus.off("pagerendered", onPageRendered);
      eventBus.off("pagecancelled", onEvicted);
      eventBus.off("scalechanging", onScaleOrRotation);
      eventBus.off("rotationchanging", onScaleOrRotation);
      for (const pageNumber of rendered) {
        const pageView = viewer.getPageView(pageNumber - 1) as { div?: HTMLElement } | undefined;
        pageView?.div?.querySelector(`.${LAYER_CLASS}`)?.remove();
      }
      rendered.clear();
    },
  };
}

function appendRects(
  layer: HTMLElement,
  entry: AnnoLayerEntry,
  viewport: Parameters<typeof resolveTargetRects>[1],
  remote: boolean,
): void {
  const color = SAFE_COLOR.test(entry.color) ? entry.color : null;
  for (const rect of resolveTargetRects(entry.target, viewport)) {
    const element = document.createElement("div");
    // `annoRectRemote` no longer restyles anything — a remote selection is
    // drawn as the same filled highlight an annotation gets. It stays as a
    // marker for what this rect *is*: e2e/pdf-presence.spec.ts asserts on it,
    // and it is the only thing distinguishing an ephemeral selection from a
    // saved annotation in the DOM.
    element.className =
      entry.variant === "link" ? "annoRect annoRectLink" : remote ? "annoRect annoRectRemote" : "annoRect";
    // Singular, unlike the doc side's `data-annotation-ids`: overlapping
    // *decorations* have to be pre-split because ProseMirror drops attributes
    // where inline decorations overlap, but these are absolutely positioned
    // siblings that simply stack. `elementsFromPoint` returns all of them,
    // which is what docs/PDF.md §7 wants for overlap disambiguation. A link
    // region gets none — see AnnoLayerEntry.variant.
    if (entry.variant !== "link") element.dataset.annoId = entry.id;
    if (entry.active) element.dataset.annoActive = "true";
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    if (color) element.style.setProperty("--anno-color", color);
    layer.appendChild(element);
  }
}

/**
 * docs/PDF.md §7's hit test: one delegated listener on the viewer container,
 * never one per rect — a long document legitimately has thousands.
 *
 * The drag guard is the load-bearing part. Without it, every text selection
 * that *starts* on a highlight also fires a click when the mouse comes up, so
 * trying to select a quoted passage would instead open the annotation quoting
 * it. Movement is tracked from `pointerdown` and the handler suppressed past a
 * few pixels.
 */
export function attachAnnoClicks(
  container: HTMLElement,
  onHit: (ids: string[], event: MouseEvent) => void,
): () => void {
  const DRAG_THRESHOLD_PX = 4;
  let startX = 0;
  let startY = 0;
  let dragged = false;

  const onPointerDown = (event: PointerEvent) => {
    startX = event.clientX;
    startY = event.clientY;
    dragged = false;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (Math.abs(event.clientX - startX) > DRAG_THRESHOLD_PX || Math.abs(event.clientY - startY) > DRAG_THRESHOLD_PX) {
      dragged = true;
    }
  };
  const onClick = (event: MouseEvent) => {
    if (dragged) return;
    const ids = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((el) => (el as HTMLElement).dataset?.annoId)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    // Deduplicated but order-preserving: a multi-line highlight contributes
    // several rects with the same id, and topmost-first is what §7 wants.
    onHit([...new Set(ids)], event);
  };

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("click", onClick);

  return () => {
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("click", onClick);
  };
}
