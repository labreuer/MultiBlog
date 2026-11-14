import { test } from "node:test";
import assert from "node:assert/strict";
import { alignSheetWords, carryRange, lettersChanged } from "./pdf-quote-carry";

// docs/PDF.md §13, "Placing each anchor" — a quote whose words were corrected,
// carried through the diff of the two sheets' text. What matters is what it
// refuses: an end inside a word that was split or joined, a run the diff
// would cut at a shared space, and a range that came through as other words.

/** Carries the first occurrence of `quote` and says what came out. */
function carry(earlier: string, later: string, quote: string): { kind: string; text?: string; changed?: number } {
  const start = earlier.indexOf(quote);
  assert.ok(start >= 0, `"${quote}" is not in the earlier text`);
  const carried = carryRange(earlier, later, { start, end: start + quote.length });
  if (carried.kind === "none") return { kind: "none" };
  return { kind: carried.kind, text: later.slice(carried.range.start, carried.range.end), changed: carried.changed };
}

test("a corrected word places itself, and the quote is the later text's", () => {
  const earlier = "the modem state of things";
  const later = "the modern state of things";
  assert.deepEqual(carry(earlier, later, "modem"), { kind: "placed", text: "modern", changed: 1 - 8 / 11 });
  assert.equal(carry(earlier, later, "the modem state").text, "the modern state");
  assert.equal(carry(earlier, later, "modem state of").kind, "placed");
});

test("a third of the letters is still within the limit", () => {
  // "tbe" to "the": two of six letters, which a float puts a hair over a third.
  assert.deepEqual(carry("in tbe end", "in the end", "tbe"), { kind: "placed", text: "the", changed: 1 - 4 / 6 });
});

test("several words replaced word for word place themselves", () => {
  assert.deepEqual(carry("of tbe modem state", "of the modern state", "tbe modem"), {
    kind: "placed",
    text: "the modern",
    changed: 1 - 12 / 17,
  });
});

test("the space two changed words share does not cut their run", () => {
  const earlier = "this is an empiricafphenomenon of some note";
  const later = "this is an empirical phenomenon of some note";
  const words = alignSheetWords(earlier, later);
  assert.equal(words.runs.length, 1);
  assert.equal(words.runs[0].earlier.length, 1);
  assert.equal(words.runs[0].later.length, 2);
  // One word became two: an end on it comes through at the run's edge, a
  // proposal, and it holds both words. Cut at the space it would be "an empirical".
  assert.deepEqual(carry(earlier, later, "an empiricafphenomenon"), {
    kind: "proposal",
    text: "an empirical phenomenon",
    changed: 1 - 40 / 42,
  });
  assert.equal(carry(earlier, later, "empiricafphenomenon").text, "empirical phenomenon");
  // With both ends in shared words it is whole, and places itself.
  assert.equal(carry(earlier, later, "an empiricafphenomenon of").kind, "placed");
});

test("an end inside a word that was joined comes through nowhere", () => {
  const earlier = "a bea tific vision here";
  const later = "a beatific vision here";
  assert.equal(carry(earlier, later, "a bea").kind, "none");
  assert.equal(carry(earlier, later, "tific vision").kind, "none");
  assert.deepEqual(carry(earlier, later, "bea tific"), { kind: "proposal", text: "beatific", changed: 0 });
  assert.deepEqual(carry(earlier, later, "a bea tific vision"), { kind: "placed", text: "a beatific vision", changed: 0 });
});

test("a word the later sheet lacks comes through nowhere", () => {
  assert.equal(carry("alpha beta gamma", "alpha gamma", "beta").kind, "none");
  assert.equal(carry("alpha beta gamma", "alpha gamma", "alpha beta").kind, "none");
  assert.equal(carry("alpha beta gamma", "alpha gamma", "alpha beta gamma").text, "alpha gamma");
});

test("more than a third changed is a proposal, though the words pair one for one", () => {
  const carried = carry("we set th usiaSI of it down", "we set out with of it down", "th usiaSI");
  assert.equal(carried.kind, "proposal");
  assert.equal(carried.text, "out with");
  assert.ok(carried.changed! > 1 / 3);
});

test("the range keeps the punctuation it began and ended with", () => {
  const earlier = 'he wrote, "Sed contra cst," and left';
  const later = 'he wrote, "Sed contra est," and left';
  assert.equal(carry(earlier, later, '"Sed contra cst,"').text, '"Sed contra est,"');
  assert.equal(carry(earlier, later, "contra cst").text, "contra est");
});

test("a range that begins or ends inside a shared word keeps its place in it", () => {
  const earlier = "an unremarkable modem thingamajig";
  const later = "an unremarkable modern thingamajig";
  assert.equal(carry(earlier, later, "markable modem thing").text, "markable modern thing");
});

test("a range with no word in it has no place", () => {
  assert.equal(carry("one, two", "one, two", ", ").kind, "none");
});

test("letters changed are counted over both quotes", () => {
  assert.equal(lettersChanged("modem", "modern"), 1 - 8 / 11);
  assert.equal(lettersChanged("The same", "the  SAME."), 0);
  assert.equal(lettersChanged("abc", "xyz"), 1);
  assert.equal(lettersChanged("", ""), 0);
});
