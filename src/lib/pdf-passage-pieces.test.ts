import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPassageText, parsePassageText, skeletonOf, type PassageText } from "./pdf-fragment";
import { passagePieces, quotationText, type PieceSheet } from "./pdf-passage-pieces";

// docs/PDF_FRAGMENT_LINKS.md §2, "A quotation's segments" — a written
// quotation as a `text` value, and that value settled against the pages:
// which brackets are gaps, which keep their letters, and where a page break
// falls. The pages carry what an extraction does: a word broken apart, a
// folio and a running head at the foot.

const pagesOf = (...texts: string[]): Map<number, PieceSheet> => new Map(texts.map((text, index) => [index, { text, skeleton: skeletonOf(text) }]));

const read = (quotation: string, shorten = false): PassageText => {
  const text = quotationText(quotation, { shorten });
  assert.ok(text, quotation);
  return parsePassageText(text)!;
};

/** What each page's share outlines, and the `text` it is written as. */
const pieces = (quotation: string, pages: Map<number, PieceSheet>, through = 0, shorten = false) =>
  passagePieces(read(quotation, shorten), pages, [0], (start) => start + through)?.map((piece) => ({
    sheet: piece.sheet,
    outlined: pages.get(piece.sheet)!.text.slice(piece.range.start, piece.range.end),
    text: formatPassageText(piece.passage),
  })) ?? null;

// ---- a written quotation, as a text value ----------------------------------

test("an ellipsis is a gap, in every way it is written", () => {
  for (const gap of ["...", "…", ". . .", "[…]", "[...]", "[. . .]"]) {
    assert.equal(quotationText(`could not yet ${gap} his own`, { shorten: false }), "could+not+yet...his+own", gap);
  }
  // One at either end says only that the quotation starts or stops mid-sentence.
  assert.equal(quotationText("… could not yet call …", { shorten: false }), "could+not+yet+call");
});

test("a bracket standing alone is a gap, and one attached to a word keeps its brackets", () => {
  assert.equal(quotationText("the recieved [sic] view", { shorten: false }), "the+recieved...view");
  assert.equal(quotationText("he said [the soul] was his own", { shorten: false }), "he+said...was+his+own");
  assert.equal(quotationText("[T]he law of participation", { shorten: false }), "%5BT%5Dhe+law+of+participation");
  assert.equal(quotationText("the form[s] of thought", { shorten: false }), "the+form%5Bs%5D+of+thought");
  // What is attached to a bracket standing alone goes with it: the 's of "[the soul]'s".
  assert.equal(quotationText("and [the soul]'s fate was sealed", { shorten: false }), "and...fate+was+sealed");
  // A bracket holding a space is no word's letters.
  assert.equal(quotationText("it was be[ing done] then", { shorten: false }), "it+was...then");
});

test("with shorten, a run longer than eight words goes as its first and last three", () => {
  const long = "It is a direction in which we had all better be moving";
  assert.equal(quotationText(long, { shorten: true }), "It+is+a,better+be+moving");
  assert.equal(quotationText(long, { shorten: false }), "It+is+a+direction+in+which+we+had+all+better+be+moving");
  // Per run: a short one stays whole beside a long one.
  assert.equal(quotationText(`the soul … ${long}`, { shorten: true }), "the+soul...It+is+a,better+be+moving");
});

test("a quotation with no words has no text", () => {
  assert.equal(quotationText("… [sic] …", { shorten: false }), null);
  assert.equal(quotationText("", { shorten: false }), null);
});

// ---- settled against the pages ---------------------------------------------

const PAGE = "It is said that he could not yet call his soul his own. The law o f participation, as it was, governed the forms of thought.";

test("[…] and [sic] leave out what the page has there, or nothing", () => {
  assert.deepEqual(pieces("could not yet […] his soul his own", pagesOf(PAGE)), [
    { sheet: 0, outlined: "could not yet call his soul his own", text: "could+not+yet...his+soul+his+own" },
  ]);
  // The page has nothing where [sic] stands: a gap of no words.
  assert.deepEqual(pieces("his soul [sic] his own", pagesOf(PAGE))?.[0].outlined, "his soul his own");
});

test("a substitution's own words are inside the gap", () => {
  assert.deepEqual(pieces("The law of participation, as [the law] was, governed", pagesOf(PAGE))?.[0].outlined, "The law o f participation, as it was, governed");
});

test("an attached bracket keeps its letters or drops them, whichever the page holds", () => {
  // "[T]he" only with its letters: the page has "The".
  assert.deepEqual(pieces("[T]he law of participation", pagesOf(PAGE)), [{ sheet: 0, outlined: "The law o f participation", text: "The+law+of+participation" }]);
  // "form[s]" against "forms" keeps them, and against "form" drops them.
  assert.equal(pieces("the form[s] of thought", pagesOf(PAGE))?.[0].text, "the+forms+of+thought");
  assert.equal(pieces("the form[s] of thought", pagesOf("It was the form of thought itself."))?.[0].text, "the+form+of+thought");
  // Nothing the viewer receives holds a bracket.
  for (const quotation of ["[T]he law of participation", "the form[s] of thought"]) {
    assert.doesNotMatch(pieces(quotation, pagesOf(PAGE))?.[0].text ?? "", /%5B|%5D|\[|\]/, quotation);
  }
});

test("a long segment is shortened only where its ends still find it", () => {
  const long = "It is said that he could not yet call his soul his own";
  assert.deepEqual(pieces(long, pagesOf(PAGE))?.[0], { sheet: 0, outlined: long, text: "It+is+said,soul+his+own" });
  // Shortened by the link already, it is matched as it came.
  assert.equal(pieces(long, pagesOf(PAGE), 0, true)?.[0].outlined, long);
});

const PAGE_40 = "us figuration. It may also sometimes be detected within, but it 4 1 Original Participation";
const PAGE_41 = "is detected primarily without. The human soul may be one o f the stopping-places.";

test("a segment straddling a page break is split where the break falls", () => {
  assert.deepEqual(pieces("It may also sometimes be detected within, but it is detected primarily without", pagesOf(PAGE_40, PAGE_41), 1), [
    { sheet: 0, outlined: "It may also sometimes be detected within, but it", text: "It+may+also,within+but+it" },
    { sheet: 1, outlined: "is detected primarily without", text: "is+detected+primarily+without" },
  ]);
});

test("an elision straddling a page break ends one page's passage and starts the next", () => {
  assert.deepEqual(pieces("It may also sometimes be detected … primarily without. The human soul", pagesOf(PAGE_40, PAGE_41), 1), [
    { sheet: 0, outlined: "It may also sometimes be detected", text: "It+may+also+sometimes+be+detected" },
    { sheet: 1, outlined: "primarily without. The human soul", text: "primarily+without+The+human+soul" },
  ]);
});

test("a quotation runs onto the next page only where the locator lets it", () => {
  const across = "It may also sometimes be detected within, but it is detected primarily without";
  assert.equal(pieces(across, pagesOf(PAGE_40, PAGE_41), 0), null);
  // A shortened segment has no middle to split, so it can't straddle the break.
  assert.equal(pieces(across, pagesOf(PAGE_40, PAGE_41), 1, true), null);
  // The cited page must hold the start: a quotation wholly on the next page isn't placed there.
  assert.equal(pieces("The human soul may be one of the stopping-places", pagesOf(PAGE_40, PAGE_41), 1), null);
});

test("the first of the start sheets that holds it wins", () => {
  const pages = pagesOf("Front matter: the soul.", "Body: the soul, again.");
  assert.equal(passagePieces(read("the soul"), pages, [0, 1])?.[0].sheet, 0);
  assert.equal(passagePieces(read("the soul again"), pages, [0, 1])?.[0].sheet, 1);
  assert.equal(passagePieces(read("nowhere at all"), pages, [0, 1]), null);
});
