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
      const fitsBelow = rects.reference.y + rects.reference.height + POPOVER_GAP + height <= window.innerHeight;
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
