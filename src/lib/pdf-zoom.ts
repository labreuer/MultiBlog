// PLAN.md §19d — the arithmetic behind zoom gestures on the PDF surface.
//
// DOM-free, like src/lib/pdf-geometry.ts, and for the same reason: what a
// gesture *means* is a rule, and the rules here are the kind that are wrong by
// a factor rather than wrong by throwing. Everything that touches an element
// lives in src/components/pdf/use-pdf-zoom-gestures.ts.

/**
 * The most one gesture step may change the scale.
 *
 * A guard for the *continuous* paths — a trackpad pinch frame, a Safari
 * `gesturechange` — where a wild delta would otherwise jump several zoom
 * levels at once. A mouse notch never reaches it: `readWheel` turns a notch
 * into a tick, and a tick is `WHEEL_TICK_FACTOR`, full stop.
 */
export const MAX_STEP_IN = 1.25;
export const MAX_STEP_OUT = 0.8;

/**
 * What one notch of a mouse wheel does to the scale — pdfjs's own
 * `DEFAULT_SCALE_DELTA`, so ctrl-wheel here matches the zoom buttons and
 * Firefox's built-in viewer.
 */
export const WHEEL_TICK_FACTOR = 1.1;

/**
 * Larger is gentler. Tuned so a trackpad pinch tracks the fingers.
 *
 * (Firefox encodes a macOS pinch as `-100 * log(1 + magnification)` and Chrome
 * something close, so 100 would reproduce the fingers *exactly*; 200 is a
 * deliberate half-speed. Change it by feel, not by arithmetic.)
 */
const WHEEL_SOFTNESS = 200;

/**
 * Below this many pixels a ctrl-wheel is a trackpad pinch, not a notch.
 *
 * pdf.js's own threshold (`Math.abs(exp(-deltaY / 100) - 1) < 0.05`), which
 * puts a pinch frame under about five pixels. No mouse in pixel mode sends
 * less than that per event except a macOS mouse at the bottom of its
 * acceleration curve — which pdf.js accepts too.
 */
const PINCH_MAX_PIXELS = 5;

/**
 * At or above this many pixels a wheel event is one physical notch, whatever
 * the OS multiplied it by.
 *
 * This is the rule that gives Chrome and Firefox the same step per notch, and
 * it is the one pdf.js applies only to line mode (docs/PDF.md §10c). Chrome
 * reports a notch as 100 pixels on Windows *times the "lines per notch"
 * setting*, 53 on Linux, and a whole screen when Windows is set to scroll by
 * pages; Firefox reports 3 lines. Dividing any of those by a pixels-per-tick
 * constant makes one notch worth one, three or thirty steps depending on the
 * machine — the bug pdf.js still has open for Chrome (mozilla/pdf.js#16325).
 * A delta this large is a notch; a notch is a tick.
 */
const NOTCH_MIN_PIXELS = 40;

/**
 * Pixels per tick in the band between: high-resolution free-spinning wheels,
 * a macOS mouse under acceleration, a two-finger scroll with ctrl held.
 * pdf.js's constant; these accumulate (`createTickAccumulator`) until they
 * make a whole tick.
 */
const PIXELS_PER_TICK = 30;

export function clampScaleFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return factor < MAX_STEP_OUT ? MAX_STEP_OUT : factor > MAX_STEP_IN ? MAX_STEP_IN : factor;
}

/**
 * Whether a wheel event is asking to zoom rather than scroll.
 *
 * `ctrlKey` is a held ctrl **and** every trackpad pinch — each engine encodes
 * the pinch as a ctrl-wheel. `metaKey` is ⌘-scroll, macOS's own page zoom,
 * which the document takes for the same reason it takes the pinch.
 */
export function wheelIsZoom(keys: { readonly ctrlKey: boolean; readonly metaKey: boolean }): boolean {
  return keys.ctrlKey || keys.metaKey;
}

/** The three properties `readWheel` needs — a `WheelEvent` satisfies it. */
export interface WheelDeltas {
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

/**
 * What a zoom-wheel event *means*: a pinch frame with its own factor, or some
 * number of notches (`ticks`, positive = in), possibly fractional — the caller
 * feeds those through `createTickAccumulator` and applies `tickScaleFactor`
 * to the whole ones.
 */
export type WheelIntent =
  | { readonly kind: "pinch"; readonly factor: number }
  | { readonly kind: "ticks"; readonly ticks: number }
  | { readonly kind: "none" };

/**
 * Takes the event itself rather than its numbers, because **the order the
 * properties are read in is load-bearing** and belongs in one tested place.
 * Since Firefox 88, a wheel event whose `deltaX`/`deltaY` is read *before*
 * its `deltaMode` silently switches to pixel mode with the lines converted —
 * a compatibility shim for pages that assume pixels. Read `deltaMode` first
 * and a mouse notch stays "3 lines", which is the one shape that carries no
 * OS multiplier at all. `pdf-zoom.test.ts` asserts the order with getters.
 *
 * Sign: a positive `deltaY` is a scroll *down*, which is zoom **out**.
 */
export function readWheel(event: WheelDeltas): WheelIntent {
  const deltaMode = event.deltaMode;
  const deltaY = event.deltaY;
  if (!Number.isFinite(deltaY) || deltaY === 0) return { kind: "none" };

  if (deltaMode === 1 || deltaMode === 2) {
    // Lines or pages: one notch per event, whatever the OS calls a notch.
    // A fractional line is nothing any device is known to send; accumulate
    // rather than round it to a whole step.
    return { kind: "ticks", ticks: Math.abs(deltaY) >= 1 ? -Math.sign(deltaY) : -deltaY };
  }

  const magnitude = Math.abs(deltaY);
  if (magnitude < PINCH_MAX_PIXELS && event.deltaX === 0) {
    return { kind: "pinch", factor: clampScaleFactor(Math.exp(-deltaY / WHEEL_SOFTNESS)) };
  }
  if (magnitude >= NOTCH_MIN_PIXELS) return { kind: "ticks", ticks: -Math.sign(deltaY) };
  return { kind: "ticks", ticks: -deltaY / PIXELS_PER_TICK };
}

/**
 * Turns a stream of possibly-fractional ticks into whole ones, carrying the
 * remainder forward. A change of direction drops the carry: a reader who
 * reverses has not banked two-thirds of a step in the other direction.
 *
 * State per listener, not per module — each viewer container gets its own.
 */
export function createTickAccumulator(): (ticks: number) => number {
  let carried = 0;
  return (ticks) => {
    if (!Number.isFinite(ticks) || ticks === 0) return 0;
    if ((carried > 0 && ticks < 0) || (carried < 0 && ticks > 0)) carried = 0;
    carried += ticks;
    // `|| 0` because Math.trunc(-0.6) is -0, which is not === 0 to a strict
    // assert and reads as a sign in a log.
    const whole = Math.trunc(carried) || 0;
    carried -= whole;
    return whole;
  };
}

/** The scale multiplier for a whole number of ticks; negative ticks zoom out. */
export function tickScaleFactor(ticks: number): number {
  if (!Number.isFinite(ticks) || ticks === 0) return 1;
  return WHEEL_TICK_FACTOR ** ticks;
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
 * we build on. docs/PDF.md §10c.)
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
