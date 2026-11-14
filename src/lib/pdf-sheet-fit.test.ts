import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuadSourceItem } from "./pdf-quads";
import {
  CLOSE_MAX_RMS,
  IDENTITY_MAX_MOVEMENT,
  applyFit,
  cornerMovement,
  fitIsClose,
  fitIsIdentity,
  fitSheets,
  sharedWordEnds,
  type MeasuredSheet,
  type Point,
} from "./pdf-sheet-fit";
import { normalisePageText } from "./pdf-text";

// docs/PDF.md §13, "Placing each anchor" — whether a sheet's ink is where it
// was, read from the words two sheets share. A rectangle keeps its quads only
// where this says so, so what matters is what it refuses: ink that moved a
// little, a fit pulled by words paired wrongly, and a sheet of one line, which
// a fit with a skew in it can't hold.

const BOX = [0, 0, 400, 600];

/** Word ends as a page has them: `lines` lines of `perLine` words, each word two points on its baseline. */
function wordEnds(lines: number, perLine: number): Point[] {
  const points: Point[] = [];
  for (let line = 0; line < lines; line++) {
    for (let word = 0; word < perLine; word++) {
      const x = 40 + word * (320 / perLine);
      const y = 560 - line * 14;
      points.push([x, y], [x + 30, y]);
    }
  }
  return points;
}

const moved = (points: readonly Point[], by: (p: Point, index: number) => Point): Point[] => points.map(by);

test("ink that has not moved fits the identity", () => {
  const points = wordEnds(30, 8);
  const fit = fitSheets(points, points)!;
  assert.equal(cornerMovement(fit, BOX), 0);
  assert.equal(fit.rms, 0);
  assert.equal(fit.used, points.length);
  assert.ok(fitIsIdentity(fit, BOX));
});

test("the line is at three points of movement at a corner of the page box", () => {
  const points = wordEnds(30, 8);
  for (const [shift, identity] of [
    [2.9, true],
    [3.1, false],
    [6.8, false],
  ] as const) {
    const fit = fitSheets(points, moved(points, ([x, y]) => [x + shift, y]))!;
    assert.ok(Math.abs(cornerMovement(fit, BOX) - shift) < 1e-9);
    assert.equal(shift <= IDENTITY_MAX_MOVEMENT, identity);
    assert.equal(fitIsIdentity(fit, BOX), identity);
    // A shift fits exactly: it is close, whether or not it is the identity.
    assert.ok(fitIsClose(fit));
  }
});

test("a turn and a scale are found, as another scan of a page has them", () => {
  const points = wordEnds(30, 8);
  const [a, b, e, f] = [1.01 * Math.cos(0.005), 1.01 * Math.sin(0.005), -3, 2];
  const fit = fitSheets(points, moved(points, ([x, y]) => [a * x - b * y + e, b * x + a * y + f]))!;
  [a, b, -b, a, e, f].forEach((value, at) => assert.ok(Math.abs(fit.matrix[at] - value) < 1e-9));
  assert.ok(fit.rms < 1e-9);
  assert.ok(!fitIsIdentity(fit, BOX));
  assert.deepEqual(
    applyFit(fit, [100, 200]).map((value) => Math.round(value * 1e6) / 1e6),
    [a * 100 - b * 200 + e, b * 100 + a * 200 + f].map((value) => Math.round(value * 1e6) / 1e6),
  );
});

test("words paired with the same word elsewhere are dropped, and don't pull the fit", () => {
  const points = wordEnds(30, 8);
  // Six ends in 480 belong to words the diff paired across the sheet.
  const to = moved(points, ([x, y], index) => (index % 80 < 2 ? [x + 150, y - 200] : [x, y]));
  const fit = fitSheets(points, to)!;
  assert.equal(fit.used, points.length - 12);
  assert.ok(cornerMovement(fit, BOX) < 1e-9);
  assert.ok(fitIsIdentity(fit, BOX));
});

test("a sheet of one line is still held", () => {
  // Every point on one baseline, each read a tenth of a point off: a turn and
  // a scale are decided by two points, where a skew would have nothing across
  // the line to hold it.
  const points = wordEnds(1, 8);
  const to = moved(points, ([x, y], index) => [x + (index % 2 ? 0.1 : -0.1), y + (index % 3 ? 0.1 : -0.1)]);
  const fit = fitSheets(points, to)!;
  assert.ok(cornerMovement(fit, BOX) < 1);
  assert.ok(fitIsIdentity(fit, BOX));
});

test("too few words give no fit", () => {
  assert.equal(fitSheets([], []), null);
  assert.equal(fitSheets(wordEnds(1, 1), wordEnds(1, 1)), null);
  // Two words are enough, unless they are at one place.
  assert.ok(fitSheets(wordEnds(1, 2), wordEnds(1, 2)));
  const one: Point[] = [[10, 10], [10, 10], [10, 10], [10, 10]];
  assert.equal(fitSheets(one, one), null);
});

test("a fit that leaves the words scattered is not close", () => {
  const points = wordEnds(30, 8);
  // Each word five points up or down by turns: nothing to drop, nothing to fit.
  const fit = fitSheets(points, moved(points, ([x, y], index) => [x, y + (Math.floor(index / 2) % 2 ? 5 : -5)]))!;
  assert.ok(fit.rms > CLOSE_MAX_RMS);
  assert.ok(!fitIsClose(fit));
});

const item = (str: string, x: number, y: number, width: number): QuadSourceItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
  ascent: 0.75,
  descent: -0.25,
});

const sheet = (items: QuadSourceItem[]): MeasuredSheet => ({ ...normalisePageText(items), items });

test("the points are the ends of the words two sheets share, however their items are cut", () => {
  // Sixteen characters over 160pt, evenly spaced: "alpha" is 50 to 100, "gamma" 160 to 210.
  const earlier = sheet([item("alpha bcta gamma", 50, 700, 160), item("of delta", 50, 680, 80)]);
  // The correction cut the first line into three items and left the ink where it was.
  const later = sheet([item("alpha", 50, 700, 50), item(" beta ", 100, 700, 60), item("gamma", 160, 700, 50), item("of delta", 50, 680, 80)]);
  const { from, to } = sharedWordEnds(earlier, later);
  // "alpha", "gamma" and "delta": "bcta" has no counterpart, and "of" is too short to trust.
  assert.equal(from.length, 6);
  assert.deepEqual(from, to);
  assert.deepEqual(from.slice(0, 2), [
    [50, 697.5],
    [100, 697.5],
  ]);
  assert.ok(fitIsIdentity(fitSheets(from, to)!, BOX));

  // The same sheet with its ink seven points to the right.
  const shifted = sheet(later.items.map((it) => ({ ...it, transform: [10, 0, 0, 10, it.transform[4] + 7, it.transform[5]] })));
  const pair = sharedWordEnds(earlier, shifted);
  const fit = fitSheets(pair.from, pair.to)!;
  assert.ok(Math.abs(cornerMovement(fit, BOX) - 7) < 1e-9);
  assert.ok(!fitIsIdentity(fit, BOX));
});
