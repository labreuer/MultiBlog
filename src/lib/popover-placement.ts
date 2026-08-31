// Where a selection-anchored popover sits (PLAN.md §14i). Client-safe, so the
// rule lives in exactly one place rather than being re-derived at each of the
// sites that used to measure independently. `placePopover` and
// `provisionalPlacement` stay **pure**; everything from `popoverBoundsFor`
// down reads the live viewport.
//
// Every coordinate here is **viewport-relative** — `coordsAtPos` and
// `getBoundingClientRect` both speak that, and it's why the popovers this
// places are `position: fixed`: a `position: absolute` popover is clipped by
// the nearest scrolling ancestor, which on /side-by-side is the column's own
// `.scroller` (its `overflow-y: auto` forces `overflow-x` to clip too — CSS
// can't leave one axis visible and clip the other). `fixed` escapes that,
// at the cost of having to do this clamping by hand, since a fixed element
// has no containing block to be laid out against.
//
// **"The viewport" is the *visual* viewport, which on iOS is not the window**,
// and while a software keyboard is up `position: fixed` anchors to the
// document rather than the viewport. So the math here runs in the space
// getBoundingClientRect speaks, and only the final write to a style attribute
// is converted. Both halves, with the measurements: docs/mobile/coordinates.html.

export type PopoverAnchor = { top: number; bottom: number; left: number };
export type PopoverBounds = { top: number; right: number; bottom: number; left: number };
export type PopoverSize = { width: number; height: number };
export type PopoverPlacement = { top: number; left: number };

/** 0.5em against the root's 16px — §14i's offset from the selection itself. */
export const POPOVER_GAP = 8;

/**
 * The preferred (unclamped) spot for a popover about to open at `anchor` —
 * good enough to render at for one layout pass, which is what makes
 * `placePopover`'s measured placement possible: the popover has to exist in
 * the DOM before its size can be read. Deliberately skips clamping rather
 * than guessing a size, so the only thing ever painted is either this or
 * the fully-measured result. Shared by every popover that needs this
 * two-phase bootstrap (useSelectionPopover, useEditorAnnotationWidget)
 * rather than each re-deriving it.
 */
export function provisionalPlacement(anchor: PopoverAnchor, gap: number = POPOVER_GAP): PopoverPlacement {
  return { top: anchor.bottom + gap, left: anchor.left + gap };
}

export function placePopover(
  anchor: PopoverAnchor,
  size: PopoverSize,
  bounds: PopoverBounds,
  gap: number = POPOVER_GAP,
): PopoverPlacement {
  // **Horizontal: slide.** Preferred is the anchor's own left edge nudged
  // right by the gap; when that overflows, slide left until the right edge is
  // inside bounds rather than flipping to the anchor's other side. The
  // popover is a large fraction of a column's width (260px of ~630px), so a
  // flip overshoots the *left* edge about as readily as the preferred spot
  // overshoots the right one, and sliding keeps the popover on the anchor's
  // own line. Sliding can never cover the anchor, because the anchor is a
  // point on a line while the popover sits above or below that whole line.
  let left = anchor.left + gap;
  if (left + size.width > bounds.right) left = bounds.right - size.width;
  if (left < bounds.left) left = bounds.left;

  // **Vertical: flip.** The opposite choice from the horizontal axis, for the
  // opposite reason — sliding up would drag the popover over the very text it
  // describes, while flipping above the anchor keeps that text visible.
  let top = anchor.bottom + gap;
  if (top + size.height > bounds.bottom) {
    const flipped = anchor.top - gap - size.height;
    if (flipped >= bounds.top) top = flipped;
  }

  // Then the same two-sided clamp the horizontal axis gets. Flipping only
  // helps when the *anchor* is itself inside bounds; an anchor scrolled out of
  // view is arbitrarily far outside them and both candidate positions inherit
  // that, so without this a popover left open while its column scrolls away
  // ends up thousands of pixels off-screen rather than pinned to the edge it
  // left through. Also the fallback when the popover simply doesn't fit either
  // side of the anchor — taller than roughly half the bounds — where the
  // overlap it accepts is unavoidable.
  if (top + size.height > bounds.bottom) top = bounds.bottom - size.height;
  if (top < bounds.top) top = bounds.top;

  // The "neither axis fits" case needs no branch of its own: the axes are
  // independent, and because one resolves by sliding and the other by
  // flipping, neither can undo the other.
  return { top, left };
}

/**
 * The band the reader can actually see, in the coordinates
 * `getBoundingClientRect` speaks — the one place `visualViewport` is read for
 * sizing, so no two callers disagree about where the edges are.
 */
export function viewportBounds(): PopoverBounds {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return {
    top: 0,
    right: vv ? vv.width : window.innerWidth,
    bottom: vv ? vv.height : window.innerHeight,
    left: 0,
  };
}

/**
 * The rect a popover must stay inside: the nearest `[data-popover-bounds]`
 * ancestor if there is one (on /side-by-side that's the two-column grid, so a
 * popover never strays outside the pair it belongs to), otherwise the
 * viewport. Always intersected with the viewport — clamping into a bounds
 * element taller or wider than the window would otherwise push the popover
 * off-screen, which is the very thing this exists to prevent.
 *
 * `visualViewport`, not `window.inner*`: those agree only while no software
 * keyboard is up (docs/mobile/coordinates.html).
 */
export function popoverBoundsFor(descendant: Element | null): PopoverBounds {
  const viewport = viewportBounds();
  const el = descendant?.closest<HTMLElement>("[data-popover-bounds]");
  if (!el) return viewport;
  const rect = el.getBoundingClientRect();
  return {
    top: Math.max(rect.top, viewport.top),
    right: Math.min(rect.right, viewport.right),
    bottom: Math.min(rect.bottom, viewport.bottom),
    left: Math.max(rect.left, viewport.left),
  };
}

/** Zero-size `position: fixed` probe, kept and re-read — the read forces reflow. */
let anchorProbeEl: HTMLDivElement | null = null;

function anchorProbe(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  // isConnected, not a null check: module scope outlives a navigation.
  if (anchorProbeEl?.isConnected) return anchorProbeEl;
  anchorProbeEl = document.createElement("div");
  anchorProbeEl.setAttribute("aria-hidden", "true");
  // visibility:hidden, not display:none — the latter has no box and reports an
  // all-zero rect, which reads as "no shift" exactly when the shift is the point.
  anchorProbeEl.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(anchorProbeEl);
  return anchorProbeEl;
}

/**
 * How far a `position: fixed` element lands from where its `top`/`left` say it
 * should — zero wherever the spec is honoured, `-scrollY` on iOS with the
 * keyboard up.
 *
 * **Measured, not derived**, and don't "simplify" it to `-window.scrollY`:
 * that breaks every scrolled desktop page, and the UA guard you'd reach for
 * next fails too, since an iPad in desktop mode reports `Macintosh; Intel Mac
 * OS X 10_15_7`. Why, in full: docs/mobile/coordinates.html.
 */
export function fixedAnchorShift(): PopoverPlacement {
  const el = anchorProbe();
  if (!el) return { top: 0, left: 0 };
  const rect = el.getBoundingClientRect();
  return { top: rect.top, left: rect.left };
}

/**
 * A placement in visual-viewport coordinates, converted to the `top`/`left` a
 * `position: fixed` element needs in order to *land* there. **Apply at the
 * point of writing the style and nowhere earlier** — every other coordinate in
 * this module stays in the space `getBoundingClientRect` speaks, which is what
 * keeps one popover anchorable to another. docs/mobile/coordinates.html.
 */
export function fixedPlacementStyle(placement: PopoverPlacement): PopoverPlacement {
  const shift = fixedAnchorShift();
  return { top: placement.top - shift.top, left: placement.left - shift.left };
}

/**
 * Everything that can move a fixed popover relative to what it points at;
 * returns the unsubscribe.
 *
 * The `visualViewport` half is **not** redundant with the `window` half:
 * raising the software keyboard fires neither a window `resize` nor a window
 * `scroll` (docs/mobile/coordinates.html). Capture phase because the thing that scrolls is usually an
 * inner element — the editor's text box, a column's `.scroller` — whose scroll
 * does not bubble.
 */
export function onViewportChange(handler: () => void): () => void {
  const vv = window.visualViewport;
  window.addEventListener("scroll", handler, true);
  window.addEventListener("resize", handler);
  vv?.addEventListener("resize", handler);
  vv?.addEventListener("scroll", handler);
  return () => {
    window.removeEventListener("scroll", handler, true);
    window.removeEventListener("resize", handler);
    vv?.removeEventListener("resize", handler);
    vv?.removeEventListener("scroll", handler);
  };
}
