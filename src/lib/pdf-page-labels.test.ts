import assert from "node:assert/strict";
import { test } from "node:test";
import { pageLabelFor, usablePageLabels } from "./pdf-page-labels";

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
