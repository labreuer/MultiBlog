import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPdf } from "../../scripts/make-test-pdf";
import { extractPageItems, extractPdf } from "./pdf-extract";
import { normalisePageText } from "./pdf-text";

// docs/PDF_QUADS.md §3 — one page's items for the server's quads. This loads
// pdfjs, unlike the rest of the unit tests, because the point is what pdfjs
// hands back: the item list the stored page text was normalised from, with the
// generic family the text layer will measure each item in.

const bytes = buildTestPdf([["The quick brown fox jumps over the lazy dog."], ["A second page."]]);

test("a page's items carry the family and metrics the text layer uses, and normalise to the stored text", async () => {
  const page = await extractPageItems(bytes, 0);
  assert.ok(page);
  assert.equal(page.items[0].str, "The quick brown fox jumps over the lazy dog.");
  // The fixture's font is the standard Helvetica, which pdfjs classes as sans-serif.
  assert.equal(page.items[0].fontFamily, "sans-serif");
  assert.ok((page.items[0].ascent ?? 0) > 0);
  const extracted = await extractPdf(bytes);
  assert.equal(page.textVersion, extracted.textVersion);
  assert.equal(normalisePageText(page.items).text, extracted.pages[0]);
});

test("a page out of range is null", async () => {
  assert.equal(await extractPageItems(bytes, 2), null);
  assert.equal(await extractPageItems(bytes, -1), null);
});
