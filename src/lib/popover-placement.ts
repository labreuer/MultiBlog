// Where a selection-anchored popover sits (PLAN.md §14i). Pure and
// client-safe, so the rule lives in exactly one place rather than being
// re-derived at each of the sites that used to measure independently.
//
// Every coordinate here is **viewport-relative** — `coordsAtPos` and
// `getBoundingClientRect` both speak that, and it's why the popovers this
// places are `position: fixed`: a `position: absolute` popover is clipped by
// the nearest scrolling ancestor, which on /side-by-side is the column's own
// `.scroller` (its `overflow-y: auto` forces `overflow-x` to clip too — CSS
// can't leave one axis visible and clip the other). `fixed` escapes that,
// at the cost of having to do this clamping by hand, since a fixed element
// has no containing block to be laid out against.

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
 * The rect a popover must stay inside: the nearest `[data-popover-bounds]`
 * ancestor if there is one (on /side-by-side that's the two-column grid, so a
 * popover never strays outside the pair it belongs to), otherwise the
 * viewport. Always intersected with the viewport — clamping into a bounds
 * element taller or wider than the window would otherwise push the popover
 * off-screen, which is the very thing this exists to prevent.
 */
export function popoverBoundsFor(descendant: Element | null): PopoverBounds {
  const viewport: PopoverBounds = { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
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
