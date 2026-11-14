import { test } from "node:test";
import assert from "node:assert/strict";
import { QUOTE_CONTEXT_LENGTH, rectToQuad, type PdfTarget, type Quad } from "./pdf-anchor";
import type { QuadSourceItem } from "./pdf-quads";
import { placeQuads, placeQuote, quoteOccurrences, sheetTextOf, type QuotePlacement, type SheetGeometry } from "./pdf-placing";
import { normalisePageText } from "./pdf-text";

// docs/PDF.md §13, "Placing each anchor" — where an anchor on one version
// goes on a later one. A carry moves whatever these rules place with nobody
// looking, so what matters is where they hold back: a quote that stands
// twice, one found elsewhere with other words around it, and ink that moved.

/** An anchor on `text` at the first place `exact` stands from `from`, with the context a capture keeps. */
function anchorOn(text: string, exact: string, from = 0): { quote: PdfTarget["quote"]; position: { start: number; end: number } } {
  const start = text.indexOf(exact, from);
  assert.ok(start >= 0, `"${exact}" is in the fixture`);
  const end = start + exact.length;
  return {
    quote: { exact, prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT_LENGTH), start), suffix: text.slice(end, end + QUOTE_CONTEXT_LENGTH) },
    position: { start, end },
  };
}

const sheets = (...texts: string[]) => texts.map(sheetTextOf);
/** The placement, which is of this kind and so has a sheet and a range. */
function found(placement: QuotePlacement, kind: "placed" | "proposal"): Extract<QuotePlacement, { sheet: number }> {
  assert.equal(placement.kind, kind);
  return placement as Extract<QuotePlacement, { sheet: number }>;
}
const slice = (later: string[], placed: { sheet: number; range: { start: number; end: number } }) => later[placed.sheet].slice(placed.range.start, placed.range.end);

const FIRST = "The harbour was quiet at dawn. A gull stood on the quay and watched the boats.";
const SECOND = "By noon the market had opened. The boats came in with the tide, and the quay filled.";

test("a quote found once on its mapped sheet places itself, whatever stands around it", () => {
  const anchor = anchorOn(FIRST, "gull stood");
  // The later sheet reads otherwise around the quote, which stands on it once.
  const later = ["The harbor was quiet. One gull stood there and watched."];
  const placed = found(placeQuote(anchor, FIRST, sheets(...later), 0), "placed");
  assert.ok(placed.how === "sheet");
  assert.equal(slice(later, placed), "gull stood");
});

test("a tie on the mapped sheet is broken by the prefix and the suffix", () => {
  const earlier = "The boats left early. The boats came back late. The boats stayed out.";
  const anchor = anchorOn(earlier, "The boats", earlier.indexOf("came") - 10);
  assert.equal(anchor.position.start, earlier.indexOf("The boats came"));
  // The same three sentences, with a line added before them.
  const later = [`Tides. ${earlier}`];
  const occurrences = quoteOccurrences(sheetTextOf(later[0]), anchor.quote);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.agrees), [false, true, false]);
  const placed = found(placeQuote(anchor, earlier, sheets(...later), 0), "placed");
  assert.equal(placed.range.start, later[0].indexOf("The boats came"));
});

test("a tie the prefix and suffix don't break is found more than once, and has no place", () => {
  const earlier = "The boats left early. The boats came back late. The boats stayed out.";
  const anchor = anchorOn(earlier, "The boats", earlier.indexOf("came") - 10);
  // Neither occurrence has the words that stood around the quote.
  const none = placeQuote(anchor, earlier, sheets("At first The boats waited. At last The boats sailed."), 0);
  assert.deepEqual(none, { kind: "none", why: "several" });
  // Both have them: the sentence stands twice on the later sheet.
  const twice = placeQuote(anchor, earlier, sheets(`${earlier} ${earlier}`), 0);
  assert.deepEqual(twice, { kind: "none", why: "several" });
});

test("a quote with no words around it breaks no tie", () => {
  const whole = "Plate IV";
  const anchor = anchorOn(whole, whole);
  assert.deepEqual(anchor.quote, { exact: whole, prefix: "", suffix: "" });
  const occurrences = quoteOccurrences(sheetTextOf("Plate IV. See also Plate IV"), anchor.quote);
  assert.deepEqual(occurrences.map((occurrence) => occurrence.agrees), [true, true]);
  assert.deepEqual(placeQuote(anchor, whole, sheets("Plate IV. See also Plate IV"), 0), { kind: "none", why: "several" });
});

test("a quote found once in the whole version, its prefix and suffix agreeing, places itself on whatever sheet", () => {
  const anchor = anchorOn(FIRST, "gull stood");
  // Its sheet has no counterpart: removed, unmapped, or no map on the way.
  const later = [SECOND, `An added line. ${FIRST}`];
  const unmapped = found(placeQuote(anchor, FIRST, sheets(...later), null), "placed");
  assert.deepEqual([unmapped.sheet, unmapped.how], [1, "version"]);
  assert.equal(slice(later, unmapped), "gull stood");
  // And where the mapped sheet no longer holds it: the passage went to another sheet.
  const elsewhere = found(placeQuote(anchor, FIRST, sheets(...later), 0), "placed");
  assert.ok(elsewhere.sheet === 1 && elsewhere.how === "version");
});

test("a quote found once in the whole version without them agreeing is a proposal", () => {
  const anchor = anchorOn(FIRST, "gull stood");
  const later = [SECOND, "On the far shore a gull stood among the reeds."];
  const proposed = found(placeQuote(anchor, FIRST, sheets(...later), null), "proposal");
  assert.ok(proposed.sheet === 1 && proposed.how === "version");
  assert.equal(slice(later, proposed), "gull stood");
});

test("a quote that was the whole of its sheet's text has nothing to agree with, and is a proposal", () => {
  const whole = "Plate IV";
  const anchor = anchorOn(whole, whole);
  const proposed = found(placeQuote(anchor, whole, sheets(SECOND, "Plate IV"), null), "proposal");
  assert.ok(proposed.sheet === 1);
});

test("a quote found several times in the version is a proposal where exactly one occurrence agrees, and has no place otherwise", () => {
  const anchor = anchorOn(FIRST, "the quay");
  const later = ["They walked along the quay at night.", FIRST];
  const proposed = found(placeQuote(anchor, FIRST, sheets(...later), null), "proposal");
  assert.ok(proposed.sheet === 1);
  assert.deepEqual(placeQuote(anchor, FIRST, sheets("Along the quay.", "Beside the quay."), null), { kind: "none", why: "several" });
  assert.deepEqual(placeQuote(anchor, FIRST, sheets(SECOND.replace("the quay", "the pier")), null), { kind: "none", why: "not-found" });
});

test("a quote whose words were corrected on the mapped sheet is carried, and derived anew", () => {
  const earlier = "In the modem world a gull is a rare thing.";
  const later = ["In the modern world a gull is a rare thing."];
  const anchor = anchorOn(earlier, "modem");
  const placed = found(placeQuote(anchor, earlier, sheets(...later), 0), "placed");
  assert.ok(placed.how === "corrected");
  assert.equal(slice(later, placed), "modern");
  assert.ok(Math.abs(placed.changed! - 3 / 11) < 1e-9);
});

test("a correction that changed more than a third of the quote's letters is a proposal", () => {
  const earlier = "It was tbc crowd that carried him.";
  const later = ["It was the crowd that carried him."];
  const anchor = anchorOn(earlier, "tbc");
  const proposed = found(placeQuote(anchor, earlier, sheets(...later), 0), "proposal");
  assert.ok(proposed.how === "corrected");
  assert.equal(slice(later, proposed), "the");
  // An end inside a run the diff doesn't replace word for word carries nothing.
  const joined = "It was th usiaSI of the crowd.";
  assert.deepEqual(placeQuote(anchorOn(joined, "usiaSI"), joined, sheets("It was enthusiasm of the crowd."), 0), { kind: "none", why: "not-found" });
});

test("a selection that began inside a word is carried by the diff, at the same place in the word", () => {
  const earlier = "An antidote for the antique dealer.";
  const anchor = anchorOn(earlier, "anti");
  // "anti" stands at no word boundary, so it is found nowhere by its skeleton.
  assert.deepEqual(quoteOccurrences(sheetTextOf(earlier), anchor.quote), []);
  const later = [`A line. ${earlier}`];
  const placed = found(placeQuote(anchor, earlier, sheets(...later), 0), "placed");
  assert.equal(placed.range.start, later[0].indexOf("antidote"));
  assert.equal(slice(later, placed), "anti");
});

test("the diff is not tried without the text the offsets are into, nor where they don't hold the quote", () => {
  const earlier = "In the modem world a gull is a rare thing.";
  const later = sheets("In the modern world a gull is a rare thing.");
  const anchor = anchorOn(earlier, "modem");
  assert.deepEqual(placeQuote(anchor, null, later, 0), { kind: "none", why: "not-found" });
  assert.deepEqual(placeQuote({ ...anchor, position: { start: 0, end: 5 } }, earlier, later, 0), { kind: "none", why: "not-found" });
});

test("a quote on its mapped sheet goes there, though it also stands elsewhere in the version", () => {
  const anchor = anchorOn(FIRST, "the boats");
  const later = [FIRST, SECOND.replace("The boats", "the boats")];
  assert.equal(found(placeQuote(anchor, FIRST, sheets(...later), 0), "placed").sheet, 0);
});

test("a mapped sheet the later version lacks is no mapped sheet", () => {
  const anchor = anchorOn(FIRST, "gull stood");
  assert.equal(found(placeQuote(anchor, FIRST, sheets(FIRST), 7), "placed").how, "version");
});

// ---------------------------------------------------------------------------
// A target with no words.

const BOX = [0, 0, 400, 600];
const item = (str: string, x: number, y: number): QuadSourceItem => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 10, height: 10, ascent: 0.75, descent: -0.25 });

/** A sheet of lines, each one item, `dx` points to the right of where they were set. */
function geometry(lines: string[], opts: { dx?: number; box?: number[]; rotation?: number } = {}): SheetGeometry {
  const items = lines.map((line, index) => item(line, 40 + (opts.dx ?? 0), 560 - index * 14));
  return { box: opts.box ?? BOX, rotation: opts.rotation ?? 0, measured: { ...normalisePageText(items), items } };
}

const LINES = ["alpha gamma delta", "epsilon lambda omega", "sigma kappa theta", "omicron upsilon digamma"];
const RECT: Quad[] = [rectToQuad(100, 300, 220, 380)];

test("a rectangle keeps its quads where the ink has not moved", () => {
  // The later text layer was corrected: one word reads otherwise, the ink is where it was.
  const later = geometry(["alpha gamma delta", "epsilon lambda omega", "sigma cappa theta", "omicron upsilon digamma"]);
  assert.deepEqual(placeQuads(RECT, geometry(LINES), later), { kind: "placed", quads: RECT, how: "unmoved" });
});

test("a rectangle whose sheet moved is a proposal, its quads carried by the fit", () => {
  const moved = placeQuads(RECT, geometry(LINES), geometry(LINES, { dx: 7 }));
  assert.ok(moved.kind === "proposal" && moved.how === "fitted");
  const [quad] = moved.quads;
  RECT[0].forEach((value, index) => assert.ok(Math.abs(quad[index] - (value + (index % 2 === 0 ? 7 : 0))) < 1e-6));
});

test("the same ink in another page box is a proposal and never placed", () => {
  const other = placeQuads(RECT, geometry(LINES), geometry(LINES, { box: [0, 0, 420, 620] }));
  assert.deepEqual(other, { kind: "proposal", quads: RECT, how: "fitted" });
  const turned = placeQuads(RECT, geometry(LINES), geometry(LINES, { rotation: 90 }));
  assert.equal(turned.kind, "proposal");
});

test("a rectangle on a sheet with no text is a proposal where the page box agrees, and has no place where it doesn't", () => {
  const plate = geometry([]);
  assert.deepEqual(placeQuads(RECT, plate, geometry([])), { kind: "proposal", quads: RECT, how: "no-text" });
  // One of the two was read as text and the other not: nothing to fit either.
  assert.deepEqual(placeQuads(RECT, plate, geometry(LINES)), { kind: "proposal", quads: RECT, how: "no-text" });
  assert.deepEqual(placeQuads(RECT, plate, geometry([], { box: [0, 0, 420, 620] })), { kind: "none", why: "other-box" });
});

test("two sheets with text that share too few words have no fit, and the rectangle no place", () => {
  assert.deepEqual(placeQuads(RECT, geometry(LINES), geometry(["wholly other words", "stand on this one"])), { kind: "none", why: "no-fit" });
});

test("a fit that leaves the shared words scattered carries nothing", () => {
  // Every other line five points up or down: no shift, turn and scale holds them.
  const earlier = geometry([...LINES, ...LINES.map((line) => line.split(" ").reverse().join(" "))]);
  const items = earlier.measured.items.map((it, index) => ({ ...it, transform: [10, 0, 0, 10, it.transform[4] + (index % 2 ? 9 : -9), it.transform[5]] }));
  const later: SheetGeometry = { box: BOX, rotation: 0, measured: { ...normalisePageText(items), items } };
  assert.deepEqual(placeQuads(RECT, earlier, later), { kind: "none", why: "no-fit" });
});
