// PLAN.md §19d — the arithmetic behind zoom gestures on the PDF surface.
//
// DOM-free, like src/lib/pdf-geometry.ts, and for the same reason: what a
// gesture *means* is a rule, and the rules here are the kind that are wrong by
// a factor rather than wrong by throwing. Everything that touches an element
// lives in src/components/pdf/use-pdf-zoom-gestures.ts.

/**
 * The most one gesture step may change the scale.
 *
 * A clamp is doing real work here rather than guarding against nonsense: a
 * mouse wheel notch and a trackpad pinch arrive as the *same event* with
 * deltas two orders of magnitude apart (roughly ±100 for a notch, ±2 per frame
 * for a pinch), so the curve that feels right for one is unusable for the
 * other. The exponential below is shaped for the pinch, and the clamp is what
 * keeps a wheel notch from jumping four zoom levels.
 */
export const MAX_STEP_IN = 1.25;
export const MAX_STEP_OUT = 0.8;

/** How many pixels a `deltaMode` of lines or pages is worth. */
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 100;

/** Larger is gentler. Tuned so a trackpad pinch tracks the fingers. */
const WHEEL_SOFTNESS = 200;

export function clampScaleFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return factor < MAX_STEP_OUT ? MAX_STEP_OUT : factor > MAX_STEP_IN ? MAX_STEP_IN : factor;
}

/**
 * What a ctrl-wheel event should multiply the scale by.
 *
 * `ctrlKey` on a wheel event is not really "the reader is holding ctrl" — it is
 * how every engine reports a **trackpad pinch**, which is why one handler
 * serves both and why the two have to share a curve.
 *
 * `deltaMode` is the part that bites: Firefox reports wheel deltas in *lines*
 * (`1`) where Chrome and Safari report pixels (`0`), so a handler that reads
 * `deltaY` raw zooms about sixteen times too slowly in one browser and looks
 * like a broken gesture rather than a scaling bug.
 *
 * Sign: a positive `deltaY` is a scroll *down*, which is zoom **out**.
 */
export function wheelScaleFactor(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const pixels = deltaY * (deltaMode === 1 ? PIXELS_PER_LINE : deltaMode === 2 ? PIXELS_PER_PAGE : 1);
  return clampScaleFactor(Math.exp(-pixels / WHEEL_SOFTNESS));
}

/**
 * What a two-finger pinch should multiply the scale by, from the distance
 * between the fingers now against the distance at the previous move.
 *
 * Against the *previous* move rather than the start of the gesture, so it
 * composes with whatever the scale already is — the same shape the wheel path
 * produces, so both feed one `updateScale` call and neither has to know what
 * the current scale is.
 */
export function pinchScaleFactor(previousDistance: number, distance: number): number {
  if (!(previousDistance > 0) || !(distance > 0)) return 1;
  return clampScaleFactor(distance / previousDistance);
}

/** Distance between two touch points, in whatever space they were given. */
export function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** The point a pinch should hold still: halfway between the fingers. */
export function touchMidpoint(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): [number, number] {
  return [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
}

/**
 * The scale values that mean "work it out from the container" rather than
 * naming a number.
 *
 * They are the ones that must be **re-applied** when the container changes
 * size: pdfjs computes them once, at the moment they are set, and then holds a
 * number — so a viewer fitted to a portrait phone stays fitted to a portrait
 * phone after the reader turns it sideways. (`PDFViewer` has no resize handling
 * of its own; that lives in Mozilla's viewer *application*, which is not what
 * we build on. docs/PDF.md §13.)
 */
const NAMED_SCALES = new Set(["auto", "page-fit", "page-width", "page-actual"]);

export function isNamedScale(value: string | null | undefined): boolean {
  return typeof value === "string" && NAMED_SCALES.has(value);
}

/**
 * What to multiply an explicitly-chosen scale by when the container's width
 * changes out from under it — a rotation, in practice.
 *
 * **Why a ratio rather than a re-fit.** A reader who has pinched has said what
 * size they want; re-fitting would throw that away. But holding the number
 * fixed is worse in one direction: turning a tablet from landscape to portrait
 * takes width away, and a page that fitted before now needs sideways panning to
 * read a line — the one thing a reader can't work around. Scaling with the
 * width keeps *how much of the page they see* fixed, which is the part that
 * makes a line readable, and it can never make the overflow worse than it was.
 *
 * The width ratio stands in for the ratio of the two fit-to-width scales, which
 * it equals up to pdfjs's fixed scrollbar allowance — a couple of percent at
 * phone widths, against a value the reader chose by feel in the first place.
 * Computing the real thing means either duplicating pdfjs's internal padding
 * constants or setting the scale to `page-width` to read it back, which the
 * reader would see happen.
 */
export function refitScaleFactor(previousWidth: number, nextWidth: number): number {
  if (!(previousWidth > 0) || !(nextWidth > 0)) return 1;
  return nextWidth / previousWidth;
}
