import { QUOTE_CONTEXT_LENGTH, type PdfTarget } from "./pdf-anchor";
import { normalisePageText } from "./pdf-text";

// A PDF anchor's quote — `exact` with its prefix and suffix — from a page's
// normalised text and a position in it. Isomorphic, so the viewer's capture
// (pdf-anchor-capture.ts, "use client") and the MCP server's (docs/MCP.md §8)
// build one the same way.

/**
 * The same collapse-and-trim `normalisePageText`'s final step applies, so a
 * needle taken from the DOM can be compared against a normalised haystack.
 *
 * Runs the raw string through the same normaliser by wrapping it as a single
 * synthetic text item — rather than reimplementing the pipeline — so the two
 * cannot drift. The transform matrix is a plain identity: no separator can be
 * inserted with only one item, which is exactly what is wanted here.
 */
export function normaliseNeedle(selected: string): string {
  return normalisePageText([{ str: selected, transform: [1, 0, 0, 1, 0, 0], width: 0, height: 1 }]).text;
}

/** prefix/suffix around the match, per docs/PDF.md §2. Empty when there's no position to take them from. */
export function buildQuote(
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
