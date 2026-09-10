"use client";

import { useEffect, type RefObject } from "react";
import {
  clampScaleFactor,
  pinchScaleFactor,
  touchDistance,
  touchMidpoint,
  wheelScaleFactor,
} from "@/lib/pdf-zoom";
import type { PdfViewerHandle } from "./PdfViewer";

// PLAN.md §19d — pinch and ctrl-wheel zoom the *document*, not the page.
//
// All three paths end in the same call, `viewer.updateScale({ scaleFactor,
// origin })`, whose `origin` is a **client-space [x, y] that stays under the
// fingers** (pdfjs adjusts scrollLeft/scrollTop by the scale difference around
// it). Zooming without one pulls the page out from under the reader, which on
// a phone is the whole difference between a gesture and a lurch.
//
// **Why three paths for two gestures.** A trackpad pinch is not a touch event
// anywhere — every engine reports it as a `wheel` with `ctrlKey` set, which is
// also how a held ctrl arrives, so one handler serves both. A *touch* pinch is
// two-finger `touchmove` on Chrome and Android. Safari additionally fires its
// own non-standard `gesture*` events, which carry a ready-made `scale` and are
// the path that reliably suppresses iOS's own page zoom — so it is preferred
// where it exists, and the touch path stands down as soon as one arrives.
//
// **The engine has to be told we are handling this**, or it zooms the whole
// page underneath us: every handler here runs on a **non-passive** listener and
// calls `preventDefault`, and `.viewerContainer` carries `touch-action: pan-x
// pan-y` so a one-finger drag still scrolls while pinch and double-tap zoom
// come to us. Outside the viewer, both still zoom the page as they always did.

/**
 * How long pdfjs may postpone re-rendering pages at the new scale.
 *
 * Mid-gesture it restyles (cheap, slightly soft) and schedules the real render
 * for after the fingers stop; at 0 it would re-render every page on every
 * frame of a pinch. Anything under 1000 counts as "postpone" to pdfjs, and this
 * is its own viewer's value for the same situation.
 */
const GESTURE_DRAWING_DELAY_MS = 400;

/**
 * Attaches the zoom gestures to the viewer's scroll container.
 *
 * Takes the handle as a **ref** rather than a value: the container it binds to
 * lives for the life of the document, and re-attaching non-passive listeners on
 * every render of the toolbar above it would be a lot of churn for a set of
 * handlers that read everything they need at event time anyway.
 */
export function usePdfZoomGestures(handleRef: RefObject<PdfViewerHandle | null>, ready: boolean) {
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle) return;
    const container = handle.container;

    /**
     * Coalesced to one application per frame. A pinch can emit far more moves
     * than there are frames, and each `updateScale` reflows every page box.
     */
    let queuedFactor = 1;
    let queuedOrigin: [number, number] | null = null;
    let frame = 0;

    const applyQueued = () => {
      frame = 0;
      const current = handleRef.current;
      const factor = queuedFactor;
      const origin = queuedOrigin;
      queuedFactor = 1;
      queuedOrigin = null;
      if (!current || factor === 1) return;
      current.viewer.updateScale({
        scaleFactor: factor,
        origin: origin ?? undefined,
        drawingDelay: GESTURE_DRAWING_DELAY_MS,
      });
    };

    const zoomBy = (factor: number, origin: [number, number]) => {
      // Multiplied rather than replaced: two moves inside one frame are two
      // steps of the same gesture, and dropping the first would make a fast
      // pinch travel less than a slow one.
      queuedFactor *= factor;
      queuedOrigin = origin;
      if (!frame) frame = requestAnimationFrame(applyQueued);
    };

    // ---- ctrl-wheel, and every trackpad pinch ------------------------------
    const onWheel = (event: WheelEvent) => {
      // `metaKey` as well as `ctrlKey`: on macOS, Cmd-scroll is the browser's
      // own page zoom, so leaving it alone would mean one of the two zoom
      // gestures a Mac reader has still resizing the whole site.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(wheelScaleFactor(event.deltaY, event.deltaMode), [event.clientX, event.clientY]);
    };

    // ---- Safari's gesture events ------------------------------------------
    //
    // Non-standard and WebKit-only (`GestureEvent`), so they are bound by name
    // and typed structurally rather than through the DOM lib. `scale` is
    // cumulative from the start of the gesture, so the *step* is it against the
    // last one we saw.
    let gestureScale = 1;
    let sawGesture = false;

    const onGestureStart = (event: Event) => {
      sawGesture = true;
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = typeof gesture.scale === "number" ? gesture.scale : 1;
      if (!(scale > 0)) return;
      const factor = scale / gestureScale;
      gestureScale = scale;
      const rect = container.getBoundingClientRect();
      zoomBy(clampScaleFactor(factor), [
        gesture.clientX ?? rect.left + rect.width / 2,
        gesture.clientY ?? rect.top + rect.height / 2,
      ]);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };

    // ---- two-finger touch -------------------------------------------------
    let pinchDistance = 0;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinchDistance = 0;
        return;
      }
      pinchDistance = touchDistance(event.touches[0], event.touches[1]);
    };

    const onTouchMove = (event: TouchEvent) => {
      // Where Safari's gesture events exist they are already doing this, and
      // applying both would square the zoom.
      if (sawGesture || event.touches.length !== 2) return;
      const distance = touchDistance(event.touches[0], event.touches[1]);
      const factor = pinchScaleFactor(pinchDistance, distance);
      pinchDistance = distance;
      // Only once a pinch is really under way: the first move of a two-finger
      // *scroll* would otherwise be swallowed by a factor of 1 that still
      // called preventDefault, and take the scroll with it.
      if (factor === 1) return;
      event.preventDefault();
      zoomBy(factor, touchMidpoint(event.touches[0], event.touches[1]));
    };

    const onTouchEnd = () => {
      pinchDistance = 0;
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("gesturestart", onGestureStart, { passive: false });
    container.addEventListener("gesturechange", onGestureChange, { passive: false });
    container.addEventListener("gestureend", onGestureEnd, { passive: false });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("gesturestart", onGestureStart);
      container.removeEventListener("gesturechange", onGestureChange);
      container.removeEventListener("gestureend", onGestureEnd);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [handleRef, ready]);
}
