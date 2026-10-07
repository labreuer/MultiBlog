# PDF quads from text items — measured without a browser

**Status: plan** (2026-10-06). Nothing here is built, and nothing on `main` needs it yet: its
one consumer is the MCP server's stored PDF quads (MCP.md §8, on the `api-mcp` branch).

`quadsForRange` (`src/lib/pdf-quads.ts`) turns a range of a page's normalised text into quads
from pdfjs's text items alone, with no rendered text layer. Each item gives its origin, its
direction and its whole advance (`width`), so a range that starts or ends *inside* an item
needs an estimate of where the characters before it end. Today there are two:

- **In the browser**, a canvas measures the item's string in the CSS font pdfjs's text layer
  draws it in, exactly as the text layer does before stretching each span to the item's width.
  The outline lands within 2px of a selection (PDF_FRAGMENT_LINKS.md §6).
- **Anywhere else**, characters are spaced evenly, as if every font were monospaced. On the
  e2e fixture, where each line is one item, that misses a selection by 13.5px.

Nothing on `main` computes quads on a server yet. MCP.md §8 (on `api-mcp`) will: an `annotate`
on a PDF page, or a PDF part of a minted link, stores quads the server computed, once and
for good. This plan gives the server a measured estimate before that consumer exists.

**Decided (Luke, 2026-10-06):** the server measures with **width tables for the three font
families the text layer uses**. That is better than even spacing, and good enough for now.

## 1. What the estimate is imitating

The reference is the text layer, because a selection *is* the text layer: every annotation
and anchored link made in the viewer takes its quads from `range.getClientRects()` over its
spans (`pdf-anchor-capture.ts`). What pdfjs 6.2.108 does there:

- **One family per font, always generic.** `getTextContent()`'s `styles[fontName].fontFamily`
  is the font's `fallbackName`: `serif`, `sans-serif` or `monospace`, chosen from the font's
  flags. (A font pdfjs failed to load is `InvalidPDFjsFont_<name>_<n>`, and its family is
  `<name>`.) The PDF's own embedded font never reaches the text layer.
- **Regular weight, no style.** `#ensureCtxFont` sets `ctx.font = "<size>px <family>"`, so a
  bold or italic run is measured in the regular face.
- **Only ratios matter.** The span is measured, then scaled by `--scale-x` to the item's
  width, so what places a character is its share of the item's advance in that family.
- **Kerning is in.** The browser measures and draws the span with the font's kerning.
- **One exception:** `TextLayer.fontFamilyMap` turns `sans-serif` into `Calibri, sans-serif`
  in Firefox on Windows.

So a server that knows the regular advances of whatever font a browser picks for `serif` and
`sans-serif` reproduces that browser's text layer, kerning aside. It can't know the reader's
fonts, so it picks the commonest.

## 2. The table

- **Source: Liberation Serif and Liberation Sans, regular** (2.1.5 on this machine). They are
  metric-compatible with Times New Roman and Arial, the default `serif` and `sans-serif` of
  Chrome and Edge on Windows. Arial matches Helvetica's metrics, the Mac's `sans-serif`; the
  Mac's Times is close to Times New Roman but not identical.
  - **Who it won't match:** Linux readers, whose families resolve through fontconfig (Noto
    Serif and Noto Sans on this Fedora box, both wider), Firefox on Windows (Calibri), and
    Android. Their selections and the stored quads will disagree by the difference between
    their fonts and these.
  - **Where it is exact:** a PDF that uses the standard Helvetica without embedding it. pdfjs
    paints that with its bundled `standard_fonts/LiberationSans-Regular.ttf`, so the table
    matches the painted glyphs there, which no reader's selection on Noto does. The e2e
    fixture is such a PDF.
- **No table for `monospace`.** Every monospaced font gives even spacing, which is then exact.
- **Contents:** each code point the font's `cmap` maps, with its `hmtx` advance in font units
  (2,048 to the em), about 2,300 per family: Latin through Extended-B, IPA, Greek, Cyrillic,
  general punctuation, letterlike symbols, the `ﬁ`–`ﬆ` ligatures. Encoded as runs of
  consecutive code points, about 25KB of source for both.
  - Measured on this machine: `i` is 569 and `m` 1,593 in Liberation Serif, `i` 455 and `m`
    1,706 in Liberation Sans. Even spacing treats them as equal.
- **A character neither font has:** East Asian wide and fullwidth characters are 1em, because
  any browser draws them from a CJK font where they are. Anything else gets the family's mean
  advance over `a`–`z`, which is even spacing for that one character.
- **An unknown family** (the `InvalidPDFjsFont` case) uses the `serif` table, because a
  browser that can't find a named family falls back to its default font, which is a serif
  unless the reader changed it.
- **Kerning is left out** of the first build. It is not small per pair: Liberation Serif's
  "AV" is 264 units narrower than "A" plus "V", 0.13em. But it shifts an edge only by the
  kerned pairs before it in the same item, minus their share of the item's whole advance. §5's
  measurement says whether it matters. If it does, the generator can add ASCII pair
  adjustments, measured on a canvas.

**The generator** is `scripts/generate-pdf-font-widths.ts`. It parses the `head`, `cmap`
(formats 4 and 12) and `hmtx` tables of the two TTFs itself, about 80 lines. That reads
coverage exactly. A canvas gives a plausible width for a character the font lacks: `日`, `ཀ`
and a private-use code point all measure 1,593 units in Liberation Serif, the width of its
missing-glyph box. So a canvas can't say which characters the table holds. It takes the font paths as arguments (Fedora's by default) and writes
`src/lib/pdf-font-widths-data.ts`, whose header names the fonts, their versions and the
command that regenerates it. The data is committed, and nothing regenerates it at build time.

## 3. The code

1. **`src/lib/pdf-font-widths.ts`**: `standardWidths: MeasureText`, pure and isomorphic. It sums
   advances per code point for the family's table, with §2's rules for what it lacks. It counts
   a lone surrogate as a missing character, so slicing an item mid-pair can't throw.
2. **`quadsForRange` defaults to it.** `measure` becomes `measure = standardWidths`. Even
   spacing remains for an item with no `fontFamily`, and for `monospace`, where it is exact.
   - The browser keeps passing its canvas measurer, which is better because it measures in
     the reader's own fonts. The table reaches the browser only if `getContext("2d")` fails.
   - **The cost:** the table ships in the PDF viewer's chunk, about 25KB of source beside
     pdfjs's megabytes. That buys a server caller that can't forget the measurer.
3. **One copier from `getTextContent()` to `QuadSourceItem[]`**, in `pdf-quads.ts`:
   `quadSourceItems(content)` takes `items` and `styles` and copies `str`, `transform`,
   `width`, `height`, `hasEOL`, `ascent`, `descent` and `fontFamily`. `use-pdf-fragment.ts`'s
   `pageTextFor` and `extractPdf` both use it, so the item list the offsets index can't
   differ between the two sides. `extractPdf` copies five of those fields by hand today,
   and the extra three don't touch the normaliser.
4. **`extractPageItems(bytes, pageIndex)`** in `src/lib/pdf-extract.ts`: one page's items
   through `quadSourceItems`, with the `textVersion`. It shares `getDocument`'s options with
   `extractPdf` through an extracted `openPdf(bytes)`, since a different option could change
   the text, and with it every offset. On `main`, only §5's measurement calls it. MCP.md §8's
   server quads are then: read the bytes, call this, check the normalised text against the
   stored page text, and call `quadsForRange`.

**What stays as it is:** `pdf-anchor-capture.ts`, the viewer, and every stored quad. Nothing
re-measures an anchor already stored.

## 4. Tests

- **Unit** (`src/lib/pdf-font-widths.test.ts`, and `pdf-quads.test.ts` extended):
  - the advances above, so a regenerated table that shifts them fails;
  - a fullwidth character is 1em, a character neither font has is the mean, and an unknown
    family reads as `serif`;
  - `quadsForRange` with no measurer places "mm" after "ii" by Arial's ratios when the item
    says `sans-serif`, and evenly when it names no family or `monospace`;
  - `extractPageItems` on `buildTestPdf`'s bytes (`scripts/make-test-pdf.ts`) gives items
    whose family is `sans-serif`, with the font's ascent. This loads pdfjs, so it costs about
    a second, unlike the rest of `test:unit`. It is the only test of the server half.
- **No e2e change.** Nothing visible changes: the viewer still measures with its canvas.

## 5. The measurement

It is one-off, and its results go in Appendix A. It answers two questions: does the table
reproduce a text layer whose fonts it was built from, and how far is it from one whose fonts
it wasn't?

- **The harness** is a throwaway Playwright script, not a spec. It loads pdfjs-dist's
  `TextLayer` straight into a blank page, so the reference involves no app code and needs no
  sign-in. Each text item gets a span in order (`TextLayer.textDivs`), and the server's item
  list skips the same marked-content entries, so an item index names a span.
- **The PDFs:** the e2e fixture, and the four papers and books in slot A's `.file-storage` that
  have PDF link parts (Nguyen, Adler & Borys, Checkland, Stinchcombe), read-only.
- **The passages:** about 50 per PDF, sampled so both ends fall inside an item, which is the
  only case where any estimate matters.
- **Per passage:**
  - select the range in the text layer, and convert its rects to PDF space through
    `viewport.convertToPdfPoint`, as the capture does;
  - compute the table's quads and even spacing's in Node, through `extractPageItems`;
  - record the error, in points, at the first line's left edge and the last line's right edge.
- **Two runs:**
  1. **This machine's fonts** (Noto): the spread a Linux reader sees.
  2. **Liberation**, by launching Chromium with a `FONTCONFIG_FILE` that maps the three
     families to Liberation Serif, Sans and Mono, which stands in for a Windows reader.
- **Thresholds, set before running:**
  - In the Liberation run, the p95 error is at most 1pt. If not, either the table or the item
    mapping is wrong, or kerning is bigger than §2 assumes, and the run says which.
  - In the Noto run, the table's median error is below even spacing's.
  - The 53 stored link parts on those PDFs are no reference: they start exactly at item
    origins, so a script computed them.

## 6. Not in scope

- **Kerning**, unless §5 says otherwise (§2).
- **The reader's own fonts.** A server can't know them. Only a browser-side re-measure could,
  and MCP.md §8 rejects storing anchors without quads for the browser to fill in.
- **Bold and italic tables.** The text layer measures in the regular face (§1).
- **Firefox on Windows's Calibri.** The table would need a third family for one browser.
  - Related, and outside this branch: the fragment viewer's canvas measurer passes the raw
    `fontFamily`, not `TextLayer.fontFamilyMap`'s, so in that browser it measures in Arial
    while the text layer draws in Calibri. That's a one-line fix, recorded in TODO.md rather
    than done here.
- **Quads already stored by scripts.** That covers the 53 link parts in slot A, and the 65
  Barfield links on explore, which an offline script spaced evenly. Those 65 are to become
  fragment links, which re-measure on every open.

## 7. After it merges

- **This doc becomes as-built**, the way PDF_FRAGMENT_LINKS.md did, with a row in CLAUDE.md's
  table.
- **PDF_FRAGMENT_LINKS.md §6** stops saying a server spaces characters evenly, and points here.
- **PDF.md §4**'s fragment paragraph points here for how quads come from items.
- **MCP.md §8** (on `api-mcp`, after a rebase):
  - its three steps become §3.4's call;
  - its "~80" lines for server quads shrinks to the text check;
  - its spec asserts edges within a tolerance that §5's numbers set, instead of mere overlap,
    which even spacing already passes.

## Appendix A. Measurements

Empty until §5 runs.
