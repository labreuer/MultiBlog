import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIKE_MOVED, ALIKE_SHARE, hasRunsToCompare, sheetMoved, sheetShare, sheetsAlike, type SheetInPlace } from "./pdf-sheet-alike";

// docs/PDF.md §13, "Matching the pages" — which sheets a page map pairs
// unasked. The two thresholds were settled on real files that are not in the
// repository; what is pinned here is what each number is *of*, and the cases
// the pair of them exists to tell apart: a page read badly, whose missing
// words are nowhere, and a page that reflowed, whose missing words are on the
// counterpart's neighbour.

/** A skeleton of `count` letters that shares no run with one of another seed, but by chance. */
function letters(seed: number, count: number): string {
  let state = seed * 2654435761 + 1;
  let out = "";
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(97 + (state >>> 8) % 26);
  }
  return out;
}

/** Every `every`-th letter read as a digit: what a poor reading does to a page. */
function misread(skeleton: string, every: number): string {
  return [...skeleton].map((ch, i) => (i % every === every - 1 ? "0" : ch)).join("");
}

const alone = (skeleton: string): SheetInPlace => ({ skeleton, before: "", after: "" });

test("a sheet is alike to itself, and to itself with its columns read in another order", () => {
  const left = letters(1, 1000);
  const right = letters(2, 1000);
  assert.equal(sheetShare(left + right, left + right), 1);
  assert.ok(sheetsAlike(alone(left + right), alone(left + right)));
  // Only the runs across the seam are lost: order plays no part.
  assert.ok(sheetShare(left + right, right + left) > 0.99);
  assert.ok(sheetsAlike(alone(left + right), alone(right + left)));
});

test("a run counts as often as it occurs, and each of the other sheet's answers for one", () => {
  // "abcdabcd" has five runs of four, two of them "abcd"; "abcd" holds one.
  assert.equal(sheetShare("abcdabcd", "abcd"), 1 / 5);
  assert.equal(sheetShare("abcd", "abcdabcd"), 1);
});

test("share tells the same page from another", () => {
  const page = letters(3, 2000);
  assert.ok(sheetShare(page, letters(4, 2000)) < 0.05);
  assert.ok(!sheetsAlike(alone(page), alone(letters(4, 2000))));
  // One letter in twenty misread leaves four runs in five.
  assert.ok(Math.abs(sheetShare(page, misread(page, 20)) - 0.8) < 0.01);
  assert.ok(sheetsAlike(alone(page), alone(misread(page, 20))));
  // One in five leaves one run in five, under the line.
  assert.ok(sheetShare(page, misread(page, 5)) < ALIKE_SHARE);
  assert.ok(!sheetsAlike(alone(page), alone(misread(page, 5))));
});

test("a sheet too short to hold a run is no sheet with text", () => {
  assert.ok(!hasRunsToCompare("abc"));
  assert.ok(hasRunsToCompare("abcd"));
  assert.equal(sheetShare("abc", "abc"), 0);
  assert.ok(!sheetsAlike(alone("abc"), alone("abc")));
  assert.ok(sheetsAlike(alone("abcd"), alone("abcd")));
});

test("words lost are on no sheet, and words moved are on the neighbour", () => {
  const lead = letters(5, 80);
  const body = letters(6, 1800);
  const tail = letters(7, 100);
  const sheet = lead + body + tail;
  // The later version's sheet holds the body alone. Its share of the earlier
  // sheet is the same whichever way the rest went.
  assert.ok(sheetShare(sheet, body) > 0.9);
  assert.equal(sheetShare(body, sheet), 1);

  // Lost: no neighbour has them. The two are the same page, read worse.
  assert.equal(sheetMoved(sheet, body, "", ""), 0);
  assert.ok(sheetsAlike(alone(sheet), alone(body)));

  // Moved: the lead ends the sheet before, and the tail begins the sheet after.
  const before = letters(8, 1900) + lead;
  const after = tail + letters(9, 1900);
  assert.equal(sheetMoved(sheet, body, before, after), 180 / 1980);
  assert.ok(!sheetsAlike(alone(sheet), { skeleton: body, before, after }));
  // And the other way round: the later sheet's words are all on the earlier.
  assert.equal(sheetMoved(body, sheet, "", ""), 0);
});

test("the line is at a twentieth of a sheet's letters", () => {
  const body = letters(10, 1800);
  for (const [moved, alike] of [
    [80, true],
    [100, true],
    [120, false],
  ] as const) {
    const lead = letters(11, moved);
    const sheet = lead + letters(12, 200 - moved) + body;
    const later = { skeleton: body, before: letters(13, 500) + lead, after: "" };
    assert.equal(sheetMoved(sheet, body, later.before, later.after), moved / 2000);
    assert.equal(moved / 2000 <= ALIKE_MOVED, alike);
    assert.equal(sheetsAlike(alone(sheet), later), alike);
  }
});

test("a phrase that stands again on the next sheet moves little, and one the counterpart holds moves nothing", () => {
  const phrase = letters(14, 40);
  const head = letters(15, 1000);
  const foot = letters(16, 960);
  const sheet = head + phrase + foot;
  const garbled = head + "0".repeat(40) + foot;
  const after = letters(17, 300) + phrase + letters(18, 300);
  assert.equal(sheetMoved(sheet, garbled, "", after), 40 / 2000);
  assert.ok(sheetsAlike(alone(sheet), { skeleton: garbled, before: "", after }));
  // A running head is on every sheet: what the counterpart holds has not moved.
  assert.equal(sheetMoved(sheet, sheet, "", after), 0);
});

test("a run shorter than sixteen letters on a neighbour is not moved", () => {
  const word = letters(19, 15);
  const sheet = letters(20, 500) + word + letters(21, 500);
  const other = letters(20, 500) + "0".repeat(15) + letters(21, 500);
  assert.equal(sheetMoved(sheet, other, word, ""), 0);
});
