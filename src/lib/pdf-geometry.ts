// PLAN.md §19 — the DOM-free half of "where in this document is that", shared
// by the viewer, both rails, and every jump target.
//
// Split out from the components for the same reason
// src/lib/margin-notes-layout.ts is: everything that *measures* belongs to a
// component, everything that *decides* belongs here, so the rules can be
// reasoned about (and tested) without a browser.

/** Unrotated page heights at scale 1, in PDF points, index 0 = page 1. */
export type PageHeights = readonly number[];

export type PageOffsets = {
  /** Cumulative top edge of each page in an unrotated, scale-1 stack. */
  tops: number[];
  /** Total stacked height. Never 0 for a real document, so it is safe to divide by. */
  total: number;
};

/**
 * The cumulative page-offset table every "document fraction" is computed
 * against.
 *
 * Built from `pdfPage.getViewport({ scale: 1 }).height` — a **public** pdfjs
 * API — rather than by reading `PDFViewer._pages`, which is an internal whose
 * entries don't exist for pages the viewer has evicted. That matters: pdfjs
 * virtualises, so any geometry derived from the rendered page list would be
 * undefined for exactly the pages a scrollbar most needs to place.
 *
 * Scale-1 and unrotated on purpose. A fraction has to mean the same thing for
 * two readers at different zooms and rotations, which is the whole point of
 * broadcasting fractions rather than pixels (docs/PDF.md §9).
 */
export function buildPageOffsets(heights: PageHeights): PageOffsets {
  const tops: number[] = [];
  let cursor = 0;
  for (const height of heights) {
    tops.push(cursor);
    cursor += height;
  }
  // A document of zero total height is impossible in practice (a page has a
  // MediaBox), but dividing by it would produce NaN everywhere downstream, so
  // the floor is 1 rather than a special case at each call site.
  return { tops, total: cursor || 1 };
}

/**
 * Where a point on a page sits in the whole document, as 0..1.
 *
 * `yFromTop` is in scale-1 PDF points measured **down** from the page's top
 * edge — not PDF user space, whose origin is bottom-left and whose y increases
 * upward (docs/PDF.md §5). Converting is the caller's job because only the
 * caller knows the page height it is converting against.
 */
export function documentFraction(offsets: PageOffsets, pageIndex: number, yFromTop: number): number {
  const top = offsets.tops[pageIndex];
  if (top === undefined) return 0;
  return clamp01((top + yFromTop) / offsets.total);
}

/**
 * A page's height at scale 1, recovered from the cumulative offset table.
 *
 * The table is the only source that answers for *every* page — pdfjs
 * virtualises, so a rendered page's box exists only for the handful it is
 * currently keeping. Every caller that converts PDF user space (y upward from
 * the page's bottom) into a `yFromTop` needs this, which is why it lives beside
 * `documentFraction` rather than in whichever component asked first.
 */
export function pageHeightAt(offsets: PageOffsets, pageIndex: number): number {
  const top = offsets.tops[pageIndex];
  if (top === undefined) return 0;
  return (offsets.tops[pageIndex + 1] ?? offsets.total) - top;
}

/** The inverse: which page a 0..1 fraction lands on, and how far down it. */
export function pageAtFraction(offsets: PageOffsets, fraction: number): { pageIndex: number; yFromTop: number } {
  const target = clamp01(fraction) * offsets.total;
  // Linear rather than a binary search: documents here are tens to hundreds of
  // pages, and this runs on a click, not per frame.
  let pageIndex = 0;
  for (let i = 0; i < offsets.tops.length; i++) {
    if (offsets.tops[i] <= target) pageIndex = i;
    else break;
  }
  return { pageIndex, yFromTop: target - offsets.tops[pageIndex] };
}

/**
 * The visible slab of the document, as a 0..1 range — what the right-hand
 * strip's viewport thumb draws.
 *
 * Returned as a range rather than a centre point because the thumb's *size* is
 * the information: a reader zoomed out over three pages and a reader filling
 * the screen with half of one are in genuinely different places, and a single
 * marker can't say so.
 */
export function visibleFractionRange(
  offsets: PageOffsets,
  top: { pageIndex: number; yFromTop: number },
  bottom: { pageIndex: number; yFromTop: number },
): { start: number; end: number } {
  const start = documentFraction(offsets, top.pageIndex, top.yFromTop);
  const end = documentFraction(offsets, bottom.pageIndex, bottom.yFromTop);
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * Whether the viewport thumb is tall enough to be worth drawing, per PLAN.md
 * §19's "more than something like 20px high" rule.
 *
 * A thumb shorter than this is a dash indistinguishable from an annotation
 * tick, which would make the strip harder to read rather than easier — so
 * below the threshold the strip shows ticks only.
 */
export const MIN_VIEWPORT_THUMB_PX = 20;

export function thumbIsWorthDrawing(range: { start: number; end: number }, railHeightPx: number): boolean {
  return (range.end - range.start) * railHeightPx >= MIN_VIEWPORT_THUMB_PX;
}

/**
 * How far down the viewport a jumped-to passage should land, as a fraction of
 * the viewer's height.
 *
 * Not zero — flush against the top edge — for two reasons, both about what the
 * reader can see once they arrive. A passage at the very top has no context
 * above it, so a quote that begins mid-sentence arrives with its first half off
 * screen. And the annotation panel's own chrome overlays the top of the rail
 * (PdfAnnotations.module.css's `.stack`), so the card belonging to a passage up
 * there is the one card the reader cannot read.
 */
export const JUMP_VIEWPORT_FRACTION = 0.25;

/**
 * Where down the viewport the "you are here" line sits, as a fraction of the
 * viewer's height — what the Contents pane asks about (PLAN.md §19b).
 *
 * Not the top edge, for two reasons. A line flush against the top flickers
 * between two entries as a heading crosses it by a pixel, and — more usefully —
 * a heading a reader has *just* scrolled past should stay current for the
 * screenful it introduces rather than handing over the moment it leaves.
 *
 * It matches JUMP_VIEWPORT_FRACTION on purpose but is a separate constant: this
 * is where the reader is deemed to be, that is where a jump puts a passage, and
 * a change to one is not a reason to change the other. Keeping them equal does
 * mean an anchored jump lands its passage exactly on the line.
 */
export const READING_LINE_FRACTION = 0.25;

/**
 * The PDF-space y to hand an `XYZ` destination so a passage lands `fraction`
 * down the viewport instead of against its top edge.
 *
 * **docs/PDF.md §5's "Navigating to a point" is the contract** — that the offset
 * is *added* because PDF y increases upward, that an out-of-page result needs no
 * clamp, and, most easily got wrong, that `cssPixelsPerPoint` is
 * `viewer.currentScale * PixelsPerInch.PDF_TO_CSS_UNITS` and never
 * `currentScale` alone. Read it before changing the arithmetic below; every
 * line of it is one sign or factor away from a plausible wrong answer.
 */
export function jumpDestinationY(
  quadTopY: number,
  viewportHeightPx: number,
  cssPixelsPerPoint: number,
  fraction: number = JUMP_VIEWPORT_FRACTION,
): number {
  // A non-positive scale would divide the offset into nonsense. It only happens
  // before the first layout, where the unshifted destination is right anyway.
  if (!(cssPixelsPerPoint > 0)) return quadTopY;
  return quadTopY + (viewportHeightPx * fraction) / cssPixelsPerPoint;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
