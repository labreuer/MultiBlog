import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestPdf } from "../../scripts/make-test-pdf";
import { extractPageItems, extractPdf, extractPdfMetadata } from "./pdf-extract";
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

// jsonb refuses U+0000, so a NUL left in a stored title or label fails the
// upload. Padding in two encodings: raw bytes in a literal string, and a
// UTF-16BE title (its BOM, then a NUL pad).
test("NULs padding outline titles and page labels are dropped from what is stored", async () => {
  const padded = buildTestPdf([["One."], ["Two."]], {
    outline: [
      { title: "Chapter One\u0000\u0000\u0000", page: 1 },
      { title: "\u00FE\u00FF\u0000T\u0000w\u0000o\u0000\u0000", page: 2 },
    ],
    pageLabels: [{ from: 1, style: "D", prefix: "A-\u0000" }],
  });
  const metadata = await extractPdfMetadata(padded);
  assert.deepEqual(metadata.pageLabels, ["A-1", "A-2"]);
  assert.deepEqual(metadata.outline.map((entry) => entry.title), ["Chapter One", "Two"]);
  assert.ok(!JSON.stringify(metadata).includes("\\u0000"));
});
