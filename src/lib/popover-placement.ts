// The shared pieces of selection-anchored popover placement (PLAN.md §14i).
// Placement itself is @floating-ui/dom's — `computePosition` + `autoUpdate`
// at each popover's own call site — and this file keeps only what those
// sites share, so each rule lives in exactly one place rather than being
// re-derived per popover. (It used to hold a hand-rolled `placePopover`;
// that version, and the tippy.js attempt that lost the library comparison,
// are in git history — docs/TIPTAP.md's link-popover section.)
//
// Every coordinate involved is **viewport-relative** — `coordsAtPos` and
// `getBoundingClientRect` both speak that, and it's why the popovers this
// serves are `position: fixed`: a `position: absolute` popover is clipped by
// the nearest scrolling ancestor, which on /side-by-side is the column's own
// `.scroller` (its `overflow-y: auto` forces `overflow-x` to clip too — CSS
// can't leave one axis visible and clip the other). `fixed` escapes that,
// and floating-ui's `strategy: "fixed"` computes against the viewport to
// match.

import type { Middleware } from "@floating-ui/dom";

export type PopoverAnchor = { top: number; bottom: number; left: number };
/**
 * A hand-computed {top,left}. Still the shape of the editor annotation
 * *marker* (use-editor-annotation-widget.ts) — a gutter widget with domain
 * rules (hide when its anchor leaves the editor's visible band, clamp into
 * the gutter), not a popover, so floating-ui buys it nothing.
 */
export type PopoverPlacement = { top: number; left: number };

/** 0.5em against the root's 16px — §14i's offset from the selection itself. */
export const POPOVER_GAP = 8;

/**
 * The side decision, made for the *tallest* the popover can be — `tallest`
 * answers that, handed the floating element's live height — never for the
 * live height itself. Live height is what the stock `flip()` reads, and that
 * bug has been paid for once already (LinkControls): fitted live, the box
 * flipped above the selection when its result list landed and back below on
 * a pick — a box the author was typing into walked. Which edge then holds
 * still is computePosition's own arithmetic: a bottom-placed box is laid out
 * from the anchor down, a top-placed one from the anchor up, so growth
 * always lands on the far edge.
 */
export function sideForTallest(tallest: (floatingHeight: number) => number): Middleware {
  return {
    name: "sideForTallest",
    fn({ rects, placement }) {
      const height = tallest(rects.floating.height);
      const fitsBelow = rects.reference.y + rects.reference.height + POPOVER_GAP + height <= viewportSize().height;
      const fitsAbove = rects.reference.y - POPOVER_GAP - height >= 0;
      const desired = fitsBelow || !fitsAbove ? "bottom-start" : "top-start";
      return placement === desired ? {} : { reset: { placement: desired } };
    },
  };
}

/**
 * The element a popover must stay inside, for `flip`/`shift`'s `boundary`
 * option: the nearest `[data-popover-bounds]` ancestor if there is one (on
 * /side-by-side that's the two-column grid, so a popover never strays
 * outside the pair it belongs to). Undefined when there is none, which lets
 * floating-ui's default clip against the viewport; when the element is
 * present, floating-ui already intersects it with the viewport
 * (`rootBoundary`), so a bounds element taller or wider than the window
 * can't push the popover off-screen either.
 */
export function popoverBoundsElement(descendant: Element | null): HTMLElement | undefined {
  return descendant?.closest<HTMLElement>("[data-popover-bounds]") ?? undefined;
}

/**
 * The viewport a `position: fixed` popover actually has to fit in.
 *
 * `visualViewport`, never `window.inner*`: with a software keyboard up, iOS
 * shrinks the visual viewport and leaves `window.innerHeight` describing the
 * layout viewport, so the clamp band is not merely stale but wrong while
 * moving — measured on iPadOS 18.6 at 299 against an `innerHeight` of 465
 * that tracked `727 - scrollY`. floating-ui's own `getViewportRect` already
 * reads `visualViewport` for the default `'viewport'` boundary, so this
 * exists for the two places that compute a fit *outside* its middleware:
 * `sideForTallest` above, and the editor annotation marker, which is a hand
 * -positioned gutter widget rather than a floating-ui popover.
 *
 * The width difference also shows on desktop: `visualViewport.width` excludes
 * a classic scrollbar where `window.innerWidth` includes it, so popovers stop
 * ~15px sooner from the right edge on Windows and Linux. No change on macOS,
 * whose overlay scrollbars take no layout space. docs/mobile/coordinates.html.
 */
export function viewportSize(): { width: number; height: number } {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return { width: vv ? vv.width : window.innerWidth, height: vv ? vv.height : window.innerHeight };
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
 * point of writing the style and nowhere earlier** — every other coordinate
 * here stays in the space `getBoundingClientRect` speaks, which is what lets
 * one surface anchor to another. floating-ui's own call sites need none of
 * this: `computePosition` returns a value already in the floating element's
 * positioning space. It is the hand-positioned marker that does.
 * docs/mobile/coordinates.html.
 */
export function fixedPlacementStyle(placement: PopoverPlacement): PopoverPlacement {
  const shift = fixedAnchorShift();
  return { top: placement.top - shift.top, left: placement.left - shift.left };
}

/**
 * Window scroll/resize *plus* the `visualViewport` events a software keyboard
 * fires instead — raising one on iPadOS 18.6 fired neither a window `resize`
 * nor a window `scroll`, and the first window event arrived 2.5s later.
 *
 * Only for surfaces floating-ui doesn't drive: `autoUpdate` already covers
 * this, because `getOverflowAncestors` includes `window.visualViewport` and
 * it binds `scroll`/`resize` to every ancestor it collects.
 */
export function onViewportChange(handler: () => void): () => void {
  const vv = window.visualViewport;
  // Capture phase: a nested element's scroll doesn't bubble.
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
