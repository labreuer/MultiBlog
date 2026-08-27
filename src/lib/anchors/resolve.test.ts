import { test } from "node:test";
import assert from "node:assert/strict";
import { pmDocContentSchema } from "../tiptap-schema";
import { resolveAnchorInDoc } from "./resolve";

// PLAN.md §13o / §20h step 1 — the resolve rule, pinned as a table.
//
// This is the function §20h calls a "pure refactor," and until now the only
// thing standing behind that claim was a two-minute production-build e2e run.
// Its three tiers (exact offsets → windowed search → one global scan accepted
// only when unique) are all *decisions about ambiguity*, which is the kind of
// thing worth stating as cases rather than inferring from a green browser.

function docOf(...paragraphs: string[]) {
  return pmDocContentSchema.nodeFromJSON({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    })),
  });
}

// One paragraph: character index i of the text sits at ProseMirror position
// i + 1 (0 is the doc start, 1 the paragraph's content start) — the same
// arithmetic e2e/fixtures.ts's QUOTE_FROM relies on.
const BODY = "The quick brown fox jumps over the lazy dog near the river bank.";
const QUOTE = "brown fox jumps";
const FROM = BODY.indexOf(QUOTE) + 1;
const TO = FROM + QUOTE.length;

test("exact offsets that still name the quote resolve to themselves", () => {
  assert.deepEqual(resolveAnchorInDoc(docOf(BODY), FROM, TO, QUOTE), { from: FROM, to: TO });
});

test("stale offsets fall back to a unique whole-document match", () => {
  // The text moved right by "Yesterday, " — the stored offsets now name
  // something else, and the global scan is what re-finds it.
  const moved = docOf(`Yesterday, ${BODY}`);
  const shift = "Yesterday, ".length;
  assert.deepEqual(resolveAnchorInDoc(moved, FROM, TO, QUOTE), { from: FROM + shift, to: TO + shift });
});

test("an ambiguous quote resolves to nothing rather than to a guess", () => {
  // Two occurrences and offsets that match neither: guessing would put the
  // annotation on someone else's sentence, so null — which every caller
  // renders as document-level (§12h), not as an error.
  const twice = docOf(`x ${QUOTE} y`, `z ${QUOTE} w`);
  assert.equal(resolveAnchorInDoc(twice, 999, 1010, QUOTE), null);
});

test("a quote that is simply gone resolves to nothing", () => {
  assert.equal(resolveAnchorInDoc(docOf("Nothing like it here."), FROM, TO, QUOTE), null);
});

test("an empty quote is never an anchor", () => {
  assert.equal(resolveAnchorInDoc(docOf(BODY), FROM, TO, ""), null);
});

test("out-of-range offsets don't throw, they fall through to the search", () => {
  // node.textBetween would throw on any of these; the range guard in front of
  // it is what keeps a stale row from taking down the render that reads it.
  // Past the end, inverted, and negative are all just "these offsets no longer
  // name the quote" — so each one lands in the global scan and gets the same
  // unique match a merely-shifted anchor would.
  const doc = docOf(BODY);
  assert.deepEqual(resolveAnchorInDoc(doc, 5_000, 5_010, QUOTE), { from: FROM, to: TO });
  assert.deepEqual(resolveAnchorInDoc(doc, TO, FROM, QUOTE), { from: FROM, to: TO });
  assert.deepEqual(resolveAnchorInDoc(doc, -3, 2, QUOTE), { from: FROM, to: TO });
});

// The `near` tier: a hit inside the window is *more* trustworthy than a
// globally unique match, because it is the occurrence nearest where this
// anchor already was. Without it, a reading view re-resolving every anchor on
// every remote keystroke pays a full O(document × quote) scan each time.
test("the near window disambiguates what a global scan could not", () => {
  const twice = docOf(`x ${QUOTE} y`, `z ${QUOTE} w`);
  const first = 3;
  const second = `x ${QUOTE} y`.length + 2 + 3;
  assert.deepEqual(resolveAnchorInDoc(twice, 999, 1010, QUOTE, { pos: first, radius: 4 }), {
    from: first,
    to: first + QUOTE.length,
  });
  assert.deepEqual(resolveAnchorInDoc(twice, 999, 1010, QUOTE, { pos: second, radius: 4 }), {
    from: second,
    to: second + QUOTE.length,
  });
});

test("a near window that is itself ambiguous defers to the global rule", () => {
  // Window wide enough to catch both copies → back to the exactly-one test,
  // which two occurrences fail. Still null, not the closer of the two.
  const twice = docOf(`x ${QUOTE} y`, `z ${QUOTE} w`);
  assert.equal(resolveAnchorInDoc(twice, 999, 1010, QUOTE, { pos: 3, radius: 500 }), null);
});

// COLLAB.md §3, recorded as a known gap rather than worked around: a selection
// spanning a paragraph break can't be re-found once its offsets stop matching,
// because a block boundary costs more than one position and the naive
// from+len window undercounts. Pinned here so closing it later is a visible
// change to this expectation rather than a silent one.
test("a cross-block quote is not re-findable once its offsets go stale", () => {
  const doc = docOf("First half here", "second half here");
  const crossing = doc.textBetween(1, doc.content.size - 1, " ");
  assert.equal(resolveAnchorInDoc(doc, 900, 910, crossing), null);
});
