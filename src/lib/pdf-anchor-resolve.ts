"use client";

import type { PageViewport } from "pdfjs-dist";
import type { PdfTarget } from "./pdf-anchor";

// PLAN.md §19 / docs/PDF.md §4 — turning a stored `PdfTarget` back into
// rectangles on a rendered page.
//
// **The important thing about this file is how little it does.** On the doc
// side, an anchor has to be re-found on every keystroke because the document
// moves under it (src/lib/annotation-anchors.ts, and the three-tier tracking in
// annotation-highlight-extension.ts). A PDF cannot move: `sha256` is the file's
// identity, so the bytes an anchor was measured against are, by construction,
// the bytes every later reader sees. The quads are therefore *always* correct,
// and the resolve order below exists only to survive changes to **our own**
// extractor and normaliser — docs/PDF.md §4's closing note.
//
// That is why there is no re-anchoring loop, no plugin state, and no
// per-transaction cost here: a target resolves to rects with pure arithmetic,
// and the only reason to consult the text at all is to notice when a stored
// quote no longer describes what is under those quads.

export type ResolvedRect = {
  /** Page-relative CSS pixels, ready to position an absolutely-placed element with. */
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * docs/PDF.md §2's "resolution status is derived, never stored".
 *
 *  - `anchored` — the quads resolved and the quote still matches (or there was
 *    no quote to check, i.e. a rectangle selection).
 *  - `shifted`  — the quote was found, but not where `position` said. Only
 *    reachable after a `textVersion` bump; the quads are still authoritative,
 *    so this renders normally and is worth surfacing only as a diagnostic.
 *  - `orphaned` — the text under the quads fails the quote check. Rendered as
 *    an unanchored card rather than as a highlight in the wrong place.
 */
export type ResolutionStatus = "anchored" | "shifted" | "orphaned";

/**
 * The quads, in page-relative CSS pixels at the page's current scale and
 * rotation.
 *
 * **docs/PDF.md §5 names `convertToViewportRectangle`; it does not exist in
 * pdfjs 6** — the type declares only `convertToViewportPoint` and
 * `convertToPdfPoint`, and so does the shipped `pdf.mjs`. Converting the two
 * opposite corners as points and taking min/max is exactly equivalent for an
 * axis-aligned rectangle, which is all a quad's bounding box ever is here.
 * §5's *rules* are unchanged and still followed: CSS pixels, page-relative
 * coordinates, and the page's **current** rotation baked into the viewport —
 * a cached pre-rotation viewport produces rects that look plausible and sit
 * wrong.
 */
export function resolveTargetRects(target: PdfTarget, viewport: PageViewport): ResolvedRect[] {
  const rects: ResolvedRect[] = [];
  for (const quad of target.quads) {
    // A quad's bounding box in PDF space. Taking min/max rather than assuming
    // /QuadPoints order survives a quad written by something other than
    // rectToQuad — a real PDF's own /QuadPoints, if these are ever imported.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, quad[i]);
      x1 = Math.max(x1, quad[i]);
      y0 = Math.min(y0, quad[i + 1]);
      y1 = Math.max(y1, quad[i + 1]);
    }
    // Both corners, then min/max — the transform can flip either axis (a
    // rotated page does exactly that), so which converted corner is "top left"
    // isn't knowable in advance.
    const [ax, ay] = viewport.convertToViewportPoint(x0, y0);
    const [bx, by] = viewport.convertToViewportPoint(x1, y1);
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    const width = Math.abs(bx - ax);
    const height = Math.abs(by - ay);
    if (width <= 0 || height <= 0) continue;
    rects.push({ left, top, width, height });
  }
  return rects;
}

/**
 * docs/PDF.md §4's resolve order, minus step 2.
 *
 * 1. Exact quote match at `position` — the overwhelmingly common case, and free.
 * 2. *(deferred)* fuzzy match within a window. It only matters after a
 *    `textVersion` bump, and §4 warns explicitly against running it
 *    synchronously: Hypothesis shipped a bug where serial fuzzy resolution of
 *    many short quotes blocked the page for over ten seconds. Doing it properly
 *    means a worker, and steps 1/3/4 make the viewer correct without it.
 * 3. Quads — always available, always correct, since the bytes can't change.
 * 4. Orphaned — the text under the quads fails the check, so say so rather than
 *    drawing a highlight over the wrong sentence.
 *
 * `pageText` is the normalised text for this page. Passing null (not yet
 * loaded) yields `anchored`, deliberately: the quads are authoritative and a
 * missing *check* is not evidence of a problem.
 */
export function resolutionStatus(target: PdfTarget, pageText: string | null): ResolutionStatus {
  // A rectangle selection has no quote, so there is nothing that could fail.
  if (!target.quote.exact) return "anchored";
  if (pageText === null) return "anchored";

  if (target.position) {
    const atPosition = pageText.slice(target.position.start, target.position.end);
    if (atPosition === target.quote.exact) return "anchored";
  }

  // The quote is still on the page, just not where the hint said. The quads
  // haven't moved, so this is a stale *hint*, not a stale anchor.
  return pageText.includes(target.quote.exact) ? "shifted" : "orphaned";
}
