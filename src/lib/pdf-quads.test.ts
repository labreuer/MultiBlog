import { test } from "node:test";
import assert from "node:assert/strict";
import { quadsBounds } from "./pdf-anchor";
import { normalisePageText } from "./pdf-text";
import { quadSourceItems, quadsForRange, type QuadSourceItem } from "./pdf-quads";

// docs/PDF_QUADS.md — quads from text items alone. The items are
// shaped like pdfjs's: an upright 10pt font is transform [10, 0, 0, 10, x, y],
// and `width` is the whole item's advance in PDF user space.

const item = (str: string, x: number, y: number, width: number, extra: Partial<QuadSourceItem> = {}): QuadSourceItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
  ascent: 0.75,
  descent: -0.25,
  ...extra,
});

const quadsOf = (items: QuadSourceItem[], needle: string, measure?: Parameters<typeof quadsForRange>[4]) => {
  const page = normalisePageText(items);
  const start = page.text.indexOf(needle);
  assert.ok(start >= 0, `"${needle}" in "${page.text}"`);
  return quadsForRange(items, page.offsets, start, start + needle.length, measure);
};

test("a run inside one item is placed by even spacing when the item names no font family", () => {
  // Ten characters over 100pt: each is 10pt wide.
  const [quad] = quadsOf([item("abcdefghij", 50, 700, 100)], "cde");
  const box = quadsBounds([quad])!;
  assert.deepEqual([box.x0, box.x1], [70, 100]);
  // Ascent and descent are fractions of the font size above and below the baseline.
  assert.deepEqual([box.y0, box.y1], [697.5, 707.5]);
});

test("a measurer places the run where the text layer would", () => {
  // A font where "i" is narrow and "m" is wide: the run's edges follow the measured advances.
  const advance = (s: string) => [...s].reduce((sum, ch) => sum + (ch === "i" ? 1 : ch === "m" ? 3 : 2), 0);
  const items = [item("iimm", 0, 700, 80, { fontFamily: "sans-serif" })];
  const box = quadsBounds(quadsOf(items, "mm", (s) => advance(s)))!;
  // "ii" is 2 of the 8 units, so "mm" starts a quarter of the way along.
  assert.deepEqual([box.x0, box.x1], [20, 80]);
  // Without a font family the measurer has nothing to measure in, and even spacing stands.
  const even = quadsBounds(quadsOf([item("iimm", 0, 700, 80)], "mm", (s) => advance(s)))!;
  assert.deepEqual([even.x0, even.x1], [40, 80]);
});

test("with no measurer, a run is placed in the standard widths of the item's family", () => {
  // Liberation Sans, Arial's metrics: "i" is 455 units and "m" 1,706, so "ii"
  // is 910 of the 4,322 units "iimm" spans.
  const sans = quadsBounds(quadsOf([item("iimm", 0, 700, 80, { fontFamily: "sans-serif" })], "mm"))!;
  assert.ok(Math.abs(sans.x0 - (80 * 910) / 4322) < 1e-9, `${sans.x0}`);
  assert.equal(sans.x1, 80);
  // In monospace even spacing is exact, and it is what the measurer gives.
  const mono = quadsBounds(quadsOf([item("iimm", 0, 700, 80, { fontFamily: "monospace" })], "mm"))!;
  assert.deepEqual([mono.x0, mono.x1], [40, 80]);
});

test("items are copied from getTextContent with their fonts' metrics, marked content skipped", () => {
  const items = quadSourceItems({
    items: [
      { type: "beginMarkedContent" },
      { str: "Hello", transform: [10, 0, 0, 10, 0, 700], width: 25, height: 10, hasEOL: false, fontName: "g_f1" },
      { type: "endMarkedContent" },
      { str: "world", transform: [10, 0, 0, 10, 30, 700], width: 25, height: 10, hasEOL: true, fontName: "g_f9" },
    ],
    styles: { g_f1: { ascent: 0.9, descent: -0.2, fontFamily: "serif" } },
  });
  assert.deepEqual(items, [
    { str: "Hello", transform: [10, 0, 0, 10, 0, 700], width: 25, height: 10, hasEOL: false, ascent: 0.9, descent: -0.2, fontFamily: "serif" },
    // A font with no style entry: no metrics, and so even spacing and pdfjs's default ascent.
    { str: "world", transform: [10, 0, 0, 10, 30, 700], width: 25, height: 10, hasEOL: true, ascent: undefined, descent: undefined, fontFamily: undefined },
  ]);
});

test("items on one line become one quad, and each line its own", () => {
  const items = [item("The law", 0, 700, 35), item("of participation", 40, 700, 80), item("governs the mind", 0, 680, 80)];
  const quads = quadsOf(items, "law of participation governs");
  assert.equal(quads.length, 2);
  const [first, second] = quads.map((quad) => quadsBounds([quad])!);
  assert.deepEqual([first.x0, first.x1], [20, 120]);
  assert.ok(second.y1 < first.y0, "the second line is below the first");
  assert.deepEqual([second.x0, second.x1], [0, 35]);
});

test("a separator the normaliser inserted is a gap, not a glyph", () => {
  // Two items with a gap pdfjs left unspaced: the normaliser adds a space,
  // attributed one past the first item's end, and a range of only that space draws nothing.
  const items = [item("left", 0, 700, 20), item("right", 40, 700, 25)];
  const page = normalisePageText(items);
  const space = page.text.indexOf(" ");
  assert.equal(page.offsets[space].charOffset, 4);
  assert.deepEqual(quadsForRange(items, page.offsets, space, space + 1), []);
});

test("a rotated item gives a quad along its baseline", () => {
  // Text running straight up the page: the baseline points along +y.
  const up: QuadSourceItem = { str: "abcd", transform: [0, 10, -10, 0, 100, 100], width: 40, height: 10, ascent: 0.8, descent: -0.2 };
  const [quad] = quadsOf([up], "bc");
  const box = quadsBounds([quad])!;
  assert.deepEqual([box.y0, box.y1], [110, 130]);
  assert.deepEqual([box.x0, box.x1], [92, 102]);
});

test("a font with no reported metrics gets pdfjs's own default ascent", () => {
  const [quad] = quadsOf([item("abc", 0, 700, 30, { ascent: undefined, descent: undefined })], "abc");
  const box = quadsBounds([quad])!;
  assert.deepEqual([box.y0, box.y1], [698, 708]);
});
