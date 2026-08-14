"use client";

import type { PageViewport } from "pdfjs-dist";
import { QUOTE_CONTEXT_LENGTH, rectToQuad, type PdfTarget, type Quad } from "./pdf-anchor";
import { normalisePageText, textVersionFor, type NormalisedPage, type PdfTextItemLike } from "./pdf-text";

// PLAN.md §19 / docs/PDF.md §5 — turning a browser `Selection` (or a drag
// rectangle) into a stored `PdfTarget`.
//
// The coordinate rules here are the ones §5 spells out, and each has a failure
// mode that is silent rather than loud if broken:
//
//  - every x/y handed to `convertToPdfPoint` is **relative to the page
//    element's top-left**, so client rects have the page div's own rect
//    subtracted first;
//  - CSS pixels from `getBoundingClientRect()`, never canvas backing-store
//    pixels — the canvas is scaled by devicePixelRatio and the viewport
//    transform is not, so a HiDPI screen would store anchors at twice the
//    coordinates;
//  - the page's **current** rotation goes into the viewport used for the
//    conversion, because rotation invalidates every cached rect.
//
// The quote and the offsets never come from the DOM. They come from
// `normalisePageText` over `getTextContent()`, which is docs/PDF.md §11's
// lesson from Hypothesis capturing a placeholder's "Loading annotations…" text
// into a selector.

/** What the capture needs to know about one rendered page. */
export type CapturePage = {
  pageIndex: number;
  /** The `.page` element PDF.js rendered — the coordinate origin for everything below. */
  div: HTMLElement;
  /** Built with the page's current scale *and* rotation. */
  viewport: PageViewport;
  /** `getTextContent().items`, already filtered to text items. */
  textItems: readonly PdfTextItemLike[];
};

/**
 * A text selection on one page.
 *
 * Returns null when the selection has no rects on this page — a collapsed
 * caret, or a selection that started here and ended somewhere pdfjs has
 * evicted.
 */
export function captureTextTarget(
  page: CapturePage,
  range: Range,
  pdfjsVersion: string,
): PdfTarget | null {
  const pageRect = page.div.getBoundingClientRect();

  // One quad per rendered line fragment, not one per selection. Zero-area
  // rects are dropped: a selection that ends exactly at a line break produces
  // one, and it would render as an invisible sliver that still counts as a
  // click target.
  const quads: Quad[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    // Intersection test rather than containment: a rect belongs to this page
    // if it overlaps it at all.
    if (rect.bottom < pageRect.top || rect.top > pageRect.bottom) continue;
    quads.push(clientRectToQuad(rect, pageRect, page.viewport));
  }
  if (quads.length === 0) return null;

  const normalised = normalisePageText(page.textItems);
  const selected = range.toString();
  const position = locateInNormalised(normalised, selected);

  return {
    pageIndex: page.pageIndex,
    quads,
    quote: buildQuote(normalised.text, position, selected),
    position,
    textVersion: textVersionFor(pdfjsVersion),
  };
}

/**
 * A rectangle dragged over a region — a figure, a table, a scanned page with
 * no text layer at all.
 *
 * The quote is empty and the position null by construction, which makes the
 * quads the *whole* anchor. That is a supported state rather than a degraded
 * one: docs/PDF.md §4's resolve order ends at "use the quads directly", and for
 * a rectangle there was never anything else to check them against.
 */
export function captureRectTarget(
  page: CapturePage,
  clientRect: { left: number; top: number; right: number; bottom: number },
  pdfjsVersion: string,
): PdfTarget | null {
  const pageRect = page.div.getBoundingClientRect();
  if (clientRect.right - clientRect.left < 2 || clientRect.bottom - clientRect.top < 2) return null;

  return {
    pageIndex: page.pageIndex,
    quads: [clientRectToQuad(clientRect, pageRect, page.viewport)],
    quote: { exact: "", prefix: "", suffix: "" },
    position: null,
    textVersion: textVersionFor(pdfjsVersion),
  };
}

/** A client-space rect → a PDF-user-space quad, via the page element's own origin. */
function clientRectToQuad(
  rect: { left: number; top: number; right: number; bottom: number },
  pageRect: DOMRect,
  viewport: PageViewport,
): Quad {
  const [x0, y0] = viewport.convertToPdfPoint(rect.left - pageRect.left, rect.top - pageRect.top);
  const [x1, y1] = viewport.convertToPdfPoint(rect.right - pageRect.left, rect.bottom - pageRect.top);
  return rectToQuad(x0, y0, x1, y1);
}

/**
 * Where the selected text sits in the page's normalised text.
 *
 * The selection's own `toString()` is raw DOM text, so it does *not* match the
 * normalised string character for character — ligatures, soft hyphens and
 * collapsed whitespace all differ. Normalising the needle the same way the
 * haystack was normalised is what makes the comparison meaningful, and it is
 * also why this can legitimately come back null (a selection spanning
 * decorative markup pdfjs put in the text layer, say). A null position is a
 * lost *hint*, not a lost anchor: the quads still resolve.
 */
function locateInNormalised(page: NormalisedPage, selected: string): { start: number; end: number } | null {
  const needle = normaliseNeedle(selected);
  if (!needle) return null;
  const start = page.text.indexOf(needle);
  if (start < 0) return null;
  return { start, end: start + needle.length };
}

/**
 * The same collapse-and-trim `normalisePageText`'s final step applies, so a
 * needle taken from the DOM can be compared against a normalised haystack.
 *
 * Runs the raw string through the same normaliser by wrapping it as a single
 * synthetic text item — rather than reimplementing the pipeline — so the two
 * cannot drift. The transform matrix is a plain identity: no separator can be
 * inserted with only one item, which is exactly what is wanted here.
 */
function normaliseNeedle(selected: string): string {
  return normalisePageText([{ str: selected, transform: [1, 0, 0, 1, 0, 0], width: 0, height: 1 }]).text;
}

/** prefix/suffix around the match, per docs/PDF.md §2. Empty when there's no position to take them from. */
function buildQuote(
  pageText: string,
  position: { start: number; end: number } | null,
  fallbackExact: string,
): PdfTarget["quote"] {
  if (!position) {
    // No position means the text wasn't found in the normalised page. The
    // normalised *selection* is still the most honest `exact` available — it is
    // what the reader highlighted — but there is nothing to take context from.
    return { exact: normaliseNeedle(fallbackExact), prefix: "", suffix: "" };
  }
  return {
    exact: pageText.slice(position.start, position.end),
    prefix: pageText.slice(Math.max(0, position.start - QUOTE_CONTEXT_LENGTH), position.start),
    suffix: pageText.slice(position.end, position.end + QUOTE_CONTEXT_LENGTH),
  };
}
