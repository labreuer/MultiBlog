"use client";

import { useEffect, type RefObject } from "react";
import { isNamedScale, refitScaleFactor } from "@/lib/pdf-zoom";
import type { PdfViewerHandle } from "./PdfViewer";

// PLAN.md §19e — keeping the zoom right when the container changes shape,
// which on a phone or tablet means a rotation.
//
// **`PDFViewer` does none of this itself.** It computes a named scale once, at
// the moment it is set, and then holds the resulting number — so a document
// fitted to a portrait phone stays fitted to a portrait phone after the reader
// turns it sideways, sitting in a column of empty space. Mozilla's viewer
// *application* re-applies the scale on window resize; we build on the library,
// which is where that responsibility stops (docs/PDF.md §13).
//
// Two rules, because the reader has said two different things:
//
// - **A named scale is a standing instruction** — "fit the width" means fit
//   *this* width, so it is re-applied whenever the container's width changes,
//   rotation or window drag or the side panel opening.
// - **A number is a decision already made**, so it is left alone by ordinary
//   resizes and only scaled by a **rotation**, in proportion to the width. See
//   `refitScaleFactor` for why that is the kinder of the two wrong answers.

/**
 * How long a rotation may take to reach the container, before we stop expecting
 * it.
 *
 * The orientation media query flips before the layout that follows it, and on
 * iOS the interface rotation is animated — so the resize we want to measure
 * arrives a few hundred milliseconds later. Without an expiry a rotation that
 * somehow produced no resize would leave the next unrelated resize being
 * treated as one.
 */
const ROTATION_SETTLE_MS = 1200;

export function usePdfRefit(handleRef: RefObject<PdfViewerHandle | null>, ready: boolean) {
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle) return;
    const container = handle.container;

    let lastWidth = container.clientWidth;
    let rotatedAt = 0;

    const onResize = () => {
      const current = handleRef.current;
      const width = container.clientWidth;
      if (!current || width <= 0 || width === lastWidth) return;
      const previousWidth = lastWidth;
      lastWidth = width;

      const named = current.viewer.currentScaleValue;
      if (isNamedScale(named)) {
        // Assigning the same string back is what makes pdfjs recompute it —
        // reading as a no-op while being the entire point, so it goes through a
        // local rather than looking like a self-assignment someone should tidy.
        // `#isSameScale` keeps it free when the answer hasn't changed.
        current.viewer.currentScaleValue = named;
        return;
      }

      // An explicit zoom, and only a rotation may touch it.
      if (Date.now() - rotatedAt > ROTATION_SETTLE_MS) return;
      rotatedAt = 0;
      const factor = refitScaleFactor(previousWidth, width);
      if (factor === 1) return;
      current.viewer.updateScale({ scaleFactor: factor });
    };

    // ResizeObserver rather than a window resize listener: the container is
    // what the scale is computed against, and it changes for reasons the window
    // never hears about — the side panel opening, an iPad split view resizing,
    // the on-screen keyboard. It also fires once on `observe`, which lands on
    // the `width === lastWidth` guard above.
    const observer = new ResizeObserver(onResize);
    observer.observe(container);

    // **A rotation is recorded, not acted on.** The orientation query flips
    // before the layout it causes, so acting here would measure the old width;
    // instead this arms the resize above, which is the event that actually
    // knows the new one.
    //
    // `matchMedia` rather than `screen.orientation` or the deprecated
    // `orientationchange`: it is the one spelling every engine in the baseline
    // agrees on, and it needs no permission or vendor path.
    const orientation = window.matchMedia("(orientation: portrait)");
    // …and only where a rotation is a real thing that happens. On a desktop the
    // same query flips when a window is dragged through square, which is not a
    // reader turning a device over and should not move a zoom they chose.
    const coarse = window.matchMedia("(pointer: coarse)");
    const onOrientation = () => {
      if (coarse.matches) rotatedAt = Date.now();
    };
    orientation.addEventListener("change", onOrientation);

    return () => {
      observer.disconnect();
      orientation.removeEventListener("change", onOrientation);
    };
  }, [handleRef, ready]);
}
