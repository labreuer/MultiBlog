import { test } from "node:test";
import assert from "node:assert/strict";
import { standardWidths } from "./pdf-font-widths";

// docs/PDF_QUADS.md §2 — the advances a server measures a text item in.
// Liberation's are in units of 1/2048 em; a regenerated table that moves these
// fails here first.

const em = (units: number) => units / 2048;
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test("the regular advances of Liberation Serif and Liberation Sans", () => {
  close(standardWidths("i", "serif"), em(569));
  close(standardWidths("m", "serif"), em(1593));
  close(standardWidths("i", "sans-serif"), em(455));
  close(standardWidths("m", "sans-serif"), em(1706));
  // A string is the sum of its characters: no kerning.
  close(standardWidths("iimm", "sans-serif"), em(2 * 455 + 2 * 1706));
});

test("monospace counts characters, a surrogate pair as one", () => {
  assert.equal(standardWidths("iimm", "monospace"), 4);
  assert.equal(standardWidths("\u{1D400}b", "monospace"), 2);
});

test("a family that isn't one of the three generics reads as serif", () => {
  assert.equal(standardWidths("Ambiguity", "InvalidFont"), standardWidths("Ambiguity", "serif"));
});

test("a character the table lacks: one em if East Asian wide, else the mean of a–z", () => {
  assert.equal(standardWidths("日", "serif"), 1);
  assert.equal(standardWidths("Ａ", "sans-serif"), 1);
  for (const family of ["serif", "sans-serif"]) {
    const mean = standardWidths("abcdefghijklmnopqrstuvwxyz", family) / 26;
    close(standardWidths("ཀ", family), mean);
    // A lone surrogate, as slicing an item inside a pair leaves one.
    close(standardWidths("\uD835", family), mean);
  }
});

test("characters PDFs carry are in the table: ligatures, dashes, curly quotes, accents, Greek", () => {
  for (const character of ["ﬁ", "ﬂ", "—", "–", "“", "’", "é", "ß", "α", "Ω"]) {
    const mean = standardWidths("abcdefghijklmnopqrstuvwxyz", "serif") / 26;
    assert.notEqual(standardWidths(character, "serif"), mean, `${character} has its own advance`);
  }
});
