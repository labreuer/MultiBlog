import { readFile } from "node:fs/promises";
import { storagePathFor } from "@/lib/file-storage";
import { extractPageItems } from "@/lib/pdf-extract";
import { storedPageText } from "@/lib/pdf-page-text";
import { normalisePageText } from "@/lib/pdf-text";
import { quadsForRange } from "@/lib/pdf-quads";
import { resolveAll, skeletonOf, type PassageText } from "@/lib/pdf-fragment";
import { buildQuote } from "@/lib/pdf-quote";
import { capturePdfTextAnchor } from "@/lib/anchors/capture";
import { overlapWindows } from "@/lib/comment-quote-match";
import { markdownToText } from "@/lib/markdown-import";
import { usablePageLabels, pagesLabelled } from "@/lib/pdf-page-labels";
import { pdfMetadata } from "@/lib/pdf-metadata";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { ApiError, ERROR_LIST_CAP, invalid } from "@/lib/api/errors";
import type { ResolvedFile } from "./resolve";
import { pageTexts } from "./read/pdf";
import type { QuoteInput } from "./annotation-writes";

// docs/MCP.md §8 — a quote anchored on a PDF page, with quads the server
// computes. `parsePdfTarget` refuses a target without quads, and the viewer
// draws, jumps to and sorts annotations only by them, so the server measures
// them itself rather than leaving the browser to fill them in — which would
// change the viewer's drawing and give up the property PDF.md §4 rests on: an
// anchor measured once is correct forever.
//
// 1. The quote is found by its **skeleton** (§7): letters and digits in order,
//    accents and case folded, a word boundary at each end — a PDF's extracted
//    text splits and joins words, which no folding of typography undoes. One
//    retry as Markdown; only a match anchors; one that occurs twice is
//    refused; near misses are reported, never anchored.
// 2. The page's text items come from the file's bytes (`extractPageItems`),
//    copied through the same `quadSourceItems` under the same options as the
//    extraction that stored the page text — and are checked against that
//    stored text before anything is trusted.
// 3. `quadsForRange` measures each line's box, in Liberation's advances where
//    an edge falls inside an item (PDF_QUADS.md).
// 4. `capturePdfTextAnchor` re-verifies the quote as it does for the viewer,
//    and an empty quote back refuses: here the server computed both sides,
//    so a mismatch means two normalisers disagree, which is worth surfacing.
//
// Limits: a quote crossing a page break needs two anchors (a target has one
// `pageIndex`); a scanned PDF has no text to find.

export async function anchorPdfQuote(
  file: ResolvedFile,
  quote: QuoteInput,
): Promise<{ target: PdfTarget; quotedText: string; label: string | null }> {
  if (file.pageCount === null) throw invalid("That file has no pages to quote: it isn't a PDF.");
  const metadata = await pdfMetadata(file.id);
  const labels = metadata ? usablePageLabels(metadata.pageLabels, file.pageCount) : null;
  const indexes =
    quote.page !== undefined
      ? [quote.page - 1]
      : quote.label !== undefined
        ? pagesLabelled(labels, quote.label)
        : Array.from({ length: file.pageCount }, (_, i) => i);
  if (indexes.some((i) => i < 0 || i >= file.pageCount!)) throw invalid(`This PDF has ${file.pageCount} pages.`);
  if (indexes.length === 0) throw new ApiError("not_found", `No page of this PDF is labelled "${quote.label}".`);
  const texts = await pageTexts(file.id, indexes);

  const passageOf = (q: QuoteInput, read: (s: string) => string): PassageText => ({
    prefix: q.prefix ? read(q.prefix) : null,
    start: read(q.quote ?? q.start ?? ""),
    end: q.quote ? null : q.end ? read(q.end) : null,
    suffix: q.suffix ? read(q.suffix) : null,
  });
  const find = (p: PassageText) =>
    indexes.flatMap((index) => {
      const text = texts.get(index) ?? "";
      return resolveAll(text, p, skeletonOf(text)).map((range) => ({ index, range }));
    });
  let found = find(passageOf(quote, (s) => s));
  if (found.length === 0) found = find(passageOf(quote, markdownToText));

  const labelOf = (index: number) => (labels ? { label: labels[index] } : {});
  if (found.length === 0) {
    const misses = indexes.flatMap((index) =>
      overlapWindows(texts.get(index) ?? "", quote.quote ?? quote.start ?? "", 3).map((w) => ({
        score: w.score,
        miss: { page: index + 1, ...labelOf(index), text: (texts.get(index) ?? "").slice(w.start, w.end) },
      })),
    );
    throw new ApiError("no_match", "That quote isn't in this PDF as written.", {
      nearMisses: misses.sort((a, b) => b.score - a.score).slice(0, 3).map((m) => m.miss),
    });
  }
  if (found.length > 1) {
    throw new ApiError("ambiguous", "That quote occurs more than once; add a prefix, a suffix or a page.", {
      occurrences: found.slice(0, ERROR_LIST_CAP).map(({ index, range }) => {
        const text = texts.get(index) ?? "";
        return { page: index + 1, ...labelOf(index), context: `…${text.slice(Math.max(0, range.start - 40), range.end + 40)}…` };
      }),
      total: found.length,
    });
  }

  const { index: pageIndex, range } = found[0];
  const items = await extractPageItems(await readFile(storagePathFor(file.sha256)), pageIndex);
  if (!items) throw invalid(`Page ${pageIndex + 1} isn't in this PDF.`);
  const normalised = normalisePageText(items.items);
  const stored = await storedPageText(file.id, pageIndex, items.textVersion);
  if (stored === null || stored !== normalised.text) {
    throw new ApiError("unavailable", "This PDF's text items don't reproduce its stored page text, so no quads can be trusted for it.");
  }
  const quads = quadsForRange(items.items, normalised.offsets, range.start, range.end);
  if (quads.length === 0) throw new ApiError("no_match", "That passage covers no glyph on the page.");
  const raw: PdfTarget = {
    pageIndex,
    quads,
    quote: buildQuote(stored, range, ""),
    position: range,
    textVersion: items.textVersion,
  };
  const captured = await capturePdfTextAnchor({ fileId: file.id, rawTarget: raw });
  if (!captured || !captured.quotedText) {
    throw new ApiError("unavailable", "The quote didn't verify against this server's own page text, so it wasn't anchored.");
  }
  return { target: captured.target, quotedText: captured.quotedText, label: labels ? labels[pageIndex] : null };
}
