# PDF quads from text items — measured without a browser

**Status: built** (2026-10-06). Its caller is the MCP server, which stores the quads it
computes for a quoted PDF passage, in an annotation or a link part ([MCP.md](MCP.md) §8,
`src/lib/mcp/pdf-anchoring.ts`).

`quadsForRange` (`src/lib/pdf-quads.ts`) turns a range of a page's normalised text into quads
from pdfjs's text items alone, with no rendered text layer. Each item gives its origin, its
direction and its whole advance (`width`). So when a range starts or ends *inside* an item,
the function has to estimate where the characters before that point end. There are three
estimates, in order of preference:

- **A canvas, in the browser.** It measures the item's string in the CSS font pdfjs's text
  layer draws it in, exactly as the text layer does before stretching each span to the item's
  width. Fragment links draw this way (PDF_FRAGMENT_LINKS.md §6), and land within 2px of a
  selection in the reader's own fonts.
- **Standard widths, anywhere else.** These are the regular advances of Liberation Serif and
  Liberation Sans, from a generated table. This is the default when a caller passes no measurer.
  Against Chromium's own text layer, 95% of edges land within 0.35pt (Appendix A).
- **Even spacing,** only for an item that names no font family, and for `monospace`, where it
  is exact.

## 1. What the estimate imitates

The reference is the text layer, because a selection *is* the text layer. Every annotation and
anchored link made in the viewer takes its quads from `range.getClientRects()` over the text
layer's spans (`pdf-anchor-capture.ts`). What pdfjs 6.2.108 does there:

- **One family per font, always generic.** `getTextContent()`'s `styles[fontName].fontFamily`
  is the font's `fallbackName`: `serif`, `sans-serif` or `monospace`, chosen from the font's
  flags. A font pdfjs failed to load is `InvalidPDFjsFont_<name>_<n>`, and its family is
  `<name>`. The PDF's own embedded font never reaches the text layer.
- **Regular weight, no style.** `#ensureCtxFont` sets `ctx.font = "<size>px <family>"`, so a
  bold or italic run is measured in the regular face.
- **Only ratios matter.** The span is measured, then scaled by `--scale-x` to the item's
  width, so what places a character is its share of the item's advance in that family.
- **Kerning is in.** The browser measures and draws the span with the font's kerning.
- **One browser-specific substitution:** `TextLayer.fontFamilyMap` turns `sans-serif` into
  `Calibri, sans-serif` in Firefox on Windows.

The fonts behind those three names belong to the reader's browser, and a server can't know
them. It picks the commonest.

## 2. The table

- **Source: Liberation Serif and Liberation Sans, regular, 2.1.5.** They share Times New
  Roman's and Arial's metrics, and Arial's are Helvetica's.
- **Who it matches exactly:**
  - Chrome and Edge on Windows, whose default `serif` and `sans-serif` are Times New Roman and
    Arial.
  - Chrome on Linux, whose default fonts are the same two names. fontconfig's metric aliases
    resolve them to Liberation wherever it is installed, which includes this Fedora box and
    the e2e suite's Chromium.
  - Mac browsers for `sans-serif` (Helvetica). The Mac's Times is close to Times New Roman
    for `serif`, but not identical.
- **Who it doesn't match:** Firefox on Linux, which takes fontconfig's own generics (Noto on
  Fedora, DejaVu on Ubuntu), Firefox on Windows (Calibri), and Android. Appendix A measures
  the first two.
- **Where it matches the painted glyphs too:** a PDF that uses the standard Helvetica without
  embedding it. pdfjs paints that with its bundled `standard_fonts/LiberationSans-Regular.ttf`.
  The e2e fixture is such a PDF.
- **No table for `monospace`.** Every monospaced font gives even spacing, so `standardWidths`
  counts characters.
- **Contents:** every code point each font's `cmap` maps, with its `hmtx` advance in font
  units, 2,048 to the em. That is 2,321 characters for the serif and 2,327 for the sans,
  covering:
  - Latin through Extended-B, and IPA;
  - Greek and Cyrillic;
  - general punctuation, letterlike symbols, and the `ﬁ`–`ﬆ` ligatures.

  It is stored as runs of consecutive code points, 34KB of source for both fonts.
- **A character neither font has.** East Asian wide and fullwidth characters count as one em,
  because any browser draws them from a CJK font, where they are that wide. Anything else gets
  the family's mean advance over `a`–`z`, which is even spacing for that one character.
- **A lone surrogate,** left where an item was sliced inside a pair, counts as such a
  character.
- **An unknown family** (the `InvalidPDFjsFont` case) reads as `serif`. A browser that can't
  find a named family falls back to its default font, which is a serif unless the reader
  changed it.
- **No kerning.** Liberation Serif's "AV" is 264 units narrower than "A" plus "V", 0.13em, but
  an edge moves only by the kerned pairs before it within its own item, net of their share of
  the item's whole advance. Against Chromium's text layer, which does kern, the table is
  within 0.35pt at p95 and 1.11pt at worst (Appendix A), so kerning isn't worth its code.

**The generator** is `scripts/generate-pdf-font-widths.ts`. It parses the TTFs' `head`, `hhea`,
`name`, `cmap` (formats 4 and 12) and `hmtx` tables itself, rather than measuring on a canvas.
A canvas gives a plausible width even for a character the font lacks: `日`, `ཀ` and a
private-use code point all measure 1,593 units in Liberation Serif, the width of its
missing-glyph box. So a canvas can't say which characters the table holds.
- It takes `--serif` and `--sans` paths, defaulting to Fedora's.
- It writes `src/lib/pdf-font-widths-data.ts`, whose header says it is generated and how to
  regenerate it.
- The output is committed, and nothing regenerates it at build time.

## 3. The code

| | |
|---|---|
| `src/lib/pdf-font-widths.ts` | `standardWidths: MeasureText`, pure and isomorphic: sums advances per code point, with §2's rules for what the table lacks |
| `src/lib/pdf-font-widths-data.ts` | the generated table |
| `src/lib/pdf-quads.ts` | `quadsForRange`, whose `measure` defaults to `standardWidths`; `quadSourceItems`, the one copier from `getTextContent()` to `QuadSourceItem[]` |
| `src/lib/pdf-extract.ts` | `extractPageItems(bytes, pageIndex)`, one page's items and `textVersion` for the server; `openPdf`, the `getDocument` options it shares with `extractPdf` |
| `scripts/generate-pdf-font-widths.ts` | the generator |

- **The default measurer means no server caller can forget it.** The browser still passes its
  canvas measurer, because that measures in the reader's own fonts. The table reaches the
  browser only if `getContext("2d")` fails. Its cost there is the table in the PDF viewer's
  chunk, small beside pdfjs.
- **One item copier for both sides.** `extractPdf`, `extractPageItems` and the fragment
  viewer's `pageTextFor` all copy items through `quadSourceItems`. So the item list that a
  stored page text's offsets index is the same list a server computes quads from.
  - It skips marked content, as the text layer does. So an item's index is also its span's
    index in `TextLayer.textDivs`.
- **One set of `getDocument` options.** `openPdf` holds them, because an option that changed
  the extracted text would change every offset stored against it.

**To compute a stored anchor's quads on the server**, which is what MCP.md §8 does:
1. read the file's bytes;
2. call `extractPageItems`;
3. check that `normalisePageText(items).text` equals the stored page text at that
   `textVersion`;
4. call `quadsForRange(items, offsets, start, end)`.

**Unchanged:** `pdf-anchor-capture.ts`, the viewer's drawing, and every stored quad. Nothing
re-measures an anchor already stored.

## 4. Tests

- **`src/lib/pdf-font-widths.test.ts`:**
  - Liberation's advances for `i` and `m` in both families, so a regenerated table that moves
    them fails here first;
  - `monospace` counting characters;
  - an unknown family reading as `serif`;
  - the one-em and mean rules;
  - ligatures, dashes, curly quotes, accents and Greek having advances of their own.
- **`src/lib/pdf-quads.test.ts`:**
  - with no measurer, a run is placed by Arial's ratios when the item says `sans-serif`, and
    evenly when it names no family or says `monospace`;
  - `quadSourceItems` skips marked content and copies the metrics.
- **`src/lib/pdf-extract.test.ts`:** `extractPageItems` on `buildTestPdf`'s bytes gives
  `sans-serif` items with the font's ascent, which normalise to exactly `extractPdf`'s page
  text. It loads pdfjs, so it takes about half a second, unlike the rest of `test:unit`.
- **No e2e change.** Nothing visible changes: the viewer still measures with its canvas.
- **`e2e/mcp-files.spec.ts` is the standing check against a real selection**: a phrase is
  selected in the viewer and posted, the same words are annotated through the MCP server, and
  every corner of the server's quads must land within 1pt of the selection's. Appendix A set
  that tolerance: against Chromium, the e2e fixture's worst edge was 0.82pt.

## 5. Limits

- **A reader on other fonts selects elsewhere.** On Noto, half of all edges are within 0.34pt
  of their selection and 95% within 1.43pt. On Carlito, the sans figures are 0.36pt and 1.74pt.
  Both are well inside a highlight's width, and three to four times closer than even spacing.
- **Firefox on Windows.** Neither its Calibri nor the fragment viewer's measurement in that
  browser is handled (TODO.md, under "PDF fragment links").
- **Bold and italic** are measured in the regular face, as the text layer measures them (§1).
- **Text that is neither Latin, Greek nor Cyrillic.** CJK falls back to one em per character,
  and anything else to even spacing.

## 6. Deviations from the plan

- **The measurement samples boundaries, not passages.** A sample is one character boundary
  inside one item, which is exactly what a passage's start or end is, and the same 1,290
  boundaries are measured in every run.
- **Three runs, not two.** Chromium on this machine was meant to stand in for a Linux reader
  on Noto. It turned out to measure in Liberation already, because Chrome's default fonts on
  Linux are Times New Roman and Arial, and fontconfig resolves them to Liberation. So Chromium's
  own defaults are the run that matches the table. Noto and Carlito were forced through a
  `FONTCONFIG_FILE` layered on the system config.
  - That config has to include the system one. A minimal config also dropped hinting
    settings, which snapped glyph advances to whole pixels and showed up as errors in the
    one family both configs left unchanged.
- **Kerning stays out,** on the numbers (§2).
- **The internal `measure` parameters are now required.** The default is applied once, in
  `quadsForRange`.

## Appendix A. Measurements

**Method.** A throwaway Playwright script, not kept:

- **Server side.** For each PDF it samples character boundaries inside text items, with these
  constraints:
  - the item is horizontal, at least four characters long, and names a family;
  - the boundary falls strictly inside the item, and maps to exactly one character of the
    normalised text;
  - sampling is seeded, up to 12 pages and 30 boundaries per page.

  For each boundary it computes the left edge of the character after it through
  `quadsForRange`, both with the default measurer and with an even one.
- **Browser side.** In Chromium, it renders pdfjs-dist's own `TextLayer` for the same page at
  scale 1, into a blank page with `pdf_viewer.css`. This needs no app code and no sign-in. It
  then takes the character's `getClientRects()` and converts them to PDF space through the
  viewport, as the capture does.
- **The PDFs:** the e2e fixture (90 boundaries) and four PDFs in slot A's file storage, 300
  boundaries each:
  - a 31-page paper (serif);
  - a 29-page paper (sans);
  - a 406-page book (both);
  - a 217-page book (both).

  The 53 stored link parts on those four PDFs are no reference, since they start exactly at
  item origins, so a script computed them.
- **Confirming each run's fonts.** Each run's canvas measured `i` and `m` at 2,048px in every
  family, to confirm which fonts it really used.

**Errors**, |computed x − selection x| in PDF points (1pt is 1.33 CSS px at the viewer's 100%):

| Run (the browser's `serif` / `sans-serif`) | Standard widths: median / p95 / max | Even: median / p95 / max | Standard widths closer |
|---|---|---|---|
| Chromium's defaults (Liberation / Liberation) | 0.02 / 0.35 / 1.11 | 1.36 / 5.97 / 18.15 | 97% |
| Noto Serif / Noto Sans | 0.34 / 1.43 / 4.13 | 1.33 / 6.32 / 19.40 | 84% |
| Liberation Serif / Carlito, all | 0.07 / 1.16 / 3.88 | 1.29 / 5.75 / 20.22 | 90% |
| Liberation Serif / Carlito, sans items only | 0.36 / 1.74 / 3.88 | 1.19 / 7.44 / 20.22 | 82% |

**Per PDF, Chromium's defaults:**

| PDF | n | Standard widths: median / p95 / max | Even: median / p95 / max |
|---|---|---|---|
| e2e fixture (14pt, one item per line) | 90 | 0.04 / 0.82 / 0.82 | 4.52 / 14.92 / 18.15 |
| 31-page paper | 300 | 0.03 / 0.51 / 1.11 | 1.98 / 7.85 / 14.20 |
| 29-page paper | 300 | 0.02 / 0.05 / 0.63 | 1.20 / 3.70 / 6.33 |
| 406-page book | 300 | 0.02 / 0.05 / 0.31 | 1.07 / 3.03 / 4.51 |
| 217-page book | 300 | 0.02 / 0.06 / 0.50 | 1.12 / 3.76 / 8.41 |

**Reading them:**

- **Even spacing's error grows with item length.** It is worst on the fixture, where a whole
  14pt line is one item, and on the paper whose items run long. Its worst cases are at the far
  end of a long item.
- **Against Liberation, the standard widths are exact but for kerning.** The largest errors
  are at kerned pairs: "A litmus" in a 10pt serif is off by 1.11pt.
- **On other fonts, the error is the gap between their proportions and Liberation's.** Noto
  Serif's `i` is 655 units against Liberation's 569, and Carlito's `m` is 1,636 against
  Liberation's 1,706. The worst of these errors is 4.13pt.
