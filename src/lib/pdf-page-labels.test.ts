import assert from "node:assert/strict";
import { test } from "node:test";
import { pageLabelFor, pageTotalLabel, usablePageLabels } from "./pdf-page-labels";

// PLAN.md §19c. The interesting half of this is what gets *rejected*: a labels
// array is built from a number tree in someone else's file, and every arm below
// is a shape a real PDF produces.

test("front matter plus a body is exactly what labels are for", () => {
  assert.deepEqual(usablePageLabels(["i", "ii", "iii", "1", "2"], 5), ["i", "ii", "iii", "1", "2"]);
});

test("labels that merely restate the page numbers are treated as absent", () => {
  assert.equal(usablePageLabels(["1", "2", "3"], 3), null);
});

test("labels that are all empty are treated as absent", () => {
  assert.equal(usablePageLabels(["", "", ""], 3), null);
});

test("a mix of empty and ordinary-number labels is still nothing to show", () => {
  assert.equal(usablePageLabels(["", "2", "", "4"], 4), null);
});

test("blanks among real labels are filled with the ordinary number, not dropped", () => {
  // Unlabelled front matter, a labelled body: the half that says something is
  // worth keeping, and the blanks have to say *something* or the page box goes
  // empty when the reader scrolls into them.
  assert.deepEqual(usablePageLabels(["", "", "1", "2"], 4), ["1", "2", "1", "2"]);
});

test("a prefix style comes through untouched", () => {
  assert.deepEqual(usablePageLabels(["A-1", "A-2", "B-1"], 3), ["A-1", "A-2", "B-1"]);
});

test("nothing, the wrong length, or a non-string entry is rejected", () => {
  assert.equal(usablePageLabels(null, 3), null);
  assert.equal(usablePageLabels(undefined, 3), null);
  assert.equal(usablePageLabels(["i", "ii"], 3), null);
  assert.equal(usablePageLabels(["i", "ii", "iii", "iv"], 3), null);
  assert.equal(usablePageLabels([], 0), null);
  assert.equal(usablePageLabels(["i", 2 as unknown as string, "iii"], 3), null);
});

test("naming a page falls back to its ordinary number with no labels at all", () => {
  assert.equal(pageLabelFor(null, 0), "1");
  assert.equal(pageLabelFor(null, 41), "42");
});

test("naming a page reads the label where there is one", () => {
  const labels = ["i", "ii", "1"];
  assert.equal(pageLabelFor(labels, 1), "ii");
  assert.equal(pageLabelFor(labels, 2), "1");
  // Off the end — a stale index from a document that has since been replaced.
  assert.equal(pageLabelFor(labels, 7), "8");
});

// `pageTotalLabel` — the "of N" beside the page box. Every arm here is a tail
// shape a real book has: a clean numbered ending, an index, an appendix run.

test("the total is the sheet count when there are no labels", () => {
  assert.equal(pageTotalLabel(null, 350), "350");
});

test("the total is the last body number, not the sheet count", () => {
  // Three sheets of front matter: sheet 6 is page 3, and 3 is what the reader's
  // copy says the book runs to.
  assert.equal(pageTotalLabel(["i", "ii", "iii", "1", "2", "3"], 6), "3");
});

test("an unnumbered tail is looked past to the last numbered page", () => {
  assert.equal(pageTotalLabel(["i", "1", "2", "3", "Index", "Colophon"], 6), "3");
});

test("a tail of more than five unnumbered pages gives up and counts sheets", () => {
  // An appendix long enough to fill the window: answering "3" here would mean
  // claiming a total the document's own last numbered page is nowhere near.
  const labels = ["i", "1", "2", "3", "A-1", "A-2", "A-3", "A-4", "A-5", "A-6"];
  assert.equal(pageTotalLabel(labels, 10), "10");
});

test("the window reaches exactly five pages back and no further", () => {
  assert.equal(pageTotalLabel(["1", "9", "a", "b", "c", "d"], 6), "9");
  assert.equal(pageTotalLabel(["9", "a", "b", "c", "d", "e"], 6), "6");
});

test("the last number in the window wins, not the first", () => {
  assert.equal(pageTotalLabel(["1", "2", "3", "A-1", "12", "Index"], 6), "12");
});

test("a labels array out of step with the page count still answers", () => {
  // Only reachable from a stale handle — usablePageLabels rejects a mismatch —
  // but the read must stay inside the array either way.
  assert.equal(pageTotalLabel(["i", "1"], 6), "6");
});
