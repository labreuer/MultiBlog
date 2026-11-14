import { quadsForRange, type QuadSourceItem } from "./pdf-quads";
import { alignSheetWords, type SheetWords } from "./pdf-quote-carry";
import type { SourceOffset } from "./pdf-text";

// docs/PDF.md §13, "Placing each anchor": whether the ink of a sheet is where
// it was on the sheet's counterpart, read from the words the two share. A
// rectangle has no words to be found by, so it places itself, its quads
// unchanged, only where a transform fitted to those words is the identity.
//
// Pure. The transform's kind and both tolerances were settled on real pairs
// of files (§13, "How the numbers were measured"), so changing one means
// measuring again.

/** The fit is the identity when it moves no corner of the page box by more than this, in points. */
export const IDENTITY_MAX_MOVEMENT = 3;
/** The fit is close enough to carry a proposal's quads when it leaves no more than this, as a root mean square, in points. */
export const CLOSE_MAX_RMS = 2.5;

/** A shared word counts from this many characters: "of" and "a" are paired with one another all over a sheet. */
const SHARED_WORD_MIN = 3;
/** A fit needs two words, which is four ends. */
const FIT_MIN_POINTS = 4;

export type Point = readonly [number, number];

export type SheetFit = {
  /** `[a, b, c, d, e, f]`, as a PDF matrix: x' = a x + c y + e, y' = b x + d y + f. */
  matrix: [number, number, number, number, number, number];
  /** How many of the points the fit kept. */
  used: number;
  /** What the fit leaves of the points it kept, as a root mean square, in points. */
  rms: number;
};

export function applyFit(fit: SheetFit, [x, y]: Point): [number, number] {
  const [a, b, c, d, e, f] = fit.matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Least squares over a shift, a turn and a scale: four numbers, which two points already decide. */
function leastSquares(from: readonly Point[], to: readonly Point[]): SheetFit["matrix"] | null {
  const n = from.length;
  let cx = 0;
  let cy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    cx += from[i][0] / n;
    cy += from[i][1] / n;
    dx += to[i][0] / n;
    dy += to[i][1] / n;
  }
  let spread = 0;
  let along = 0;
  let across = 0;
  for (let i = 0; i < n; i++) {
    const x = from[i][0] - cx;
    const y = from[i][1] - cy;
    const u = to[i][0] - dx;
    const v = to[i][1] - dy;
    spread += x * x + y * y;
    along += x * u + y * v;
    across += x * v - y * u;
  }
  if (spread < 1e-9) return null;
  const a = along / spread;
  const b = across / spread;
  return [a, b, -b, a, dx - (a * cx - b * cy), dy - (b * cx + a * cy)];
}

/**
 * The shift, turn and scale that best takes each of `from` to its counterpart
 * in `to`. Null where fewer than two words are left to fit.
 *
 * **Not a fit with a skew in it**, which has six numbers: on a sheet of a few
 * lines the points are nearly on one line, and it runs wild away from them.
 *
 * **It drops what it fits worst, twice**: every point farther from its
 * counterpart than three times the median, or than half a point where that is
 * more. A word the diff paired with the same word elsewhere on the sheet
 * would otherwise pull it.
 */
export function fitSheets(from: readonly Point[], to: readonly Point[]): SheetFit | null {
  let kept = from.map((_, index) => index);
  for (let pass = 0; ; pass++) {
    if (kept.length < FIT_MIN_POINTS) return null;
    const matrix = leastSquares(
      kept.map((index) => from[index]),
      kept.map((index) => to[index]),
    );
    if (!matrix) return null;
    const fit: SheetFit = { matrix, used: kept.length, rms: 0 };
    const left = kept.map((index) => {
      const [x, y] = applyFit(fit, from[index]);
      return Math.hypot(x - to[index][0], y - to[index][1]);
    });
    if (pass === 2) {
      fit.rms = Math.sqrt(left.reduce((sum, distance) => sum + distance * distance, 0) / left.length);
      return fit;
    }
    const cut = Math.max(3 * [...left].sort((p, q) => p - q)[Math.floor(left.length / 2)], 0.5);
    kept = kept.filter((_, at) => left[at] <= cut);
  }
}

/** How far the fit moves the corner of the page box (`[x0, y0, x1, y1]`) it moves most, in points. */
export function cornerMovement(fit: SheetFit, box: readonly number[]): number {
  const [x0, y0, x1, y1] = box;
  const corners: Point[] = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ];
  return Math.max(...corners.map((corner) => Math.hypot(applyFit(fit, corner)[0] - corner[0], applyFit(fit, corner)[1] - corner[1])));
}

/** Whether the ink has not moved: a rectangle keeps its quads. The caller has already found the two page boxes and rotations equal. */
export function fitIsIdentity(fit: SheetFit, box: readonly number[]): boolean {
  return cornerMovement(fit, box) <= IDENTITY_MAX_MOVEMENT;
}

/** Whether the fit is good enough to carry a rectangle's quads as a proposal. */
export function fitIsClose(fit: SheetFit): boolean {
  return fit.rms <= CLOSE_MAX_RMS;
}

/** One sheet as the quads are measured from it: its normalised text, that text's offsets, and its items. */
export type MeasuredSheet = { text: string; offsets: readonly SourceOffset[]; items: readonly QuadSourceItem[] };

/**
 * The points a fit is made from: the two ends of the box of each word the two
 * sheets share, as `quadsForRange` measures it on each.
 *
 * **Words, not text items**: a correction cuts a line's items anew, and an
 * item that was cut has no counterpart to compare. A word that is not one box
 * on both sheets (it is broken over two lines, or covers no glyph) is left
 * out.
 */
export function sharedWordEnds(
  earlier: MeasuredSheet,
  later: MeasuredSheet,
  words: SheetWords = alignSheetWords(earlier.text, later.text),
): { from: Point[]; to: Point[] } {
  const from: Point[] = [];
  const to: Point[] = [];
  const ends = (sheet: MeasuredSheet, start: number, end: number): [Point, Point] | null => {
    const quads = quadsForRange(sheet.items, sheet.offsets, start, end);
    if (quads.length !== 1) return null;
    const quad = quads[0];
    return [
      [quad[4], quad[5]],
      [quad[6], quad[7]],
    ];
  };
  for (const token of words.earlier) {
    if (!token.word || token.mate === null || token.end - token.start < SHARED_WORD_MIN) continue;
    const mate = words.later[token.mate];
    const before = ends(earlier, token.start, token.end);
    const after = ends(later, mate.start, mate.end);
    if (!before || !after) continue;
    from.push(...before);
    to.push(...after);
  }
  return { from, to };
}
