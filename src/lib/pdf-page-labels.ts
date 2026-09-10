// PLAN.md §19c — page labels: what a PDF calls its own pages.
//
// A page's *index* is where it sits in the file; its **label** is what is
// printed on it. In anything with front matter they differ — "iv" is the fourth
// sheet, "1" is the twelfth — and the label is the one the reader can act on,
// because it is what the contents page, the index and the citation all say.
//
// Indices stay 1-based everywhere internally (pdfjs's own API is, our anchors
// are, presence is). This is a **display** concern only: one function answers
// "what do we call this page", and every surface that shows a page number calls
// it.

/**
 * The labels worth using, or null to mean "just number the pages".
 *
 * `pdf.getPageLabels()` returns an entry per page or nothing at all, so most of
 * the work here is deciding when a perfectly valid answer is not worth showing:
 *
 * - **Every label is its own ordinary number.** Plenty of files carry a
 *   /PageLabels tree that reproduces 1…N exactly. Using it changes no glyph on
 *   screen and costs "of 350" its meaning as a matching pair with the box
 *   beside it, so it is treated as absent.
 * - **Every label is empty.** A /PageLabels range with no style and no prefix
 *   produces `""` for each of its pages (pdfjs builds the array that way rather
 *   than leaving holes), and a blank page box is worse than a number.
 *
 * A *partly* empty set is kept, with the blanks filled in by the ordinary
 * number — front matter often has no labels while the body does, and dropping
 * the whole set for that would throw away the half that is informative. The
 * filled-in array is what gets handed to `PDFViewer.setPageLabels` too, so what
 * we display, what pdfjs puts on `data-page-label`, and what
 * `pageLabelToPageNumber` will match are one and the same list.
 *
 * A length mismatch is rejected outright: pdfjs refuses it as well (with a
 * console error), and a labels array that doesn't line up with the pages is
 * not something to guess at.
 */
export function usablePageLabels(
  labels: readonly string[] | null | undefined,
  pageCount: number,
): string[] | null {
  if (!Array.isArray(labels) || labels.length !== pageCount || pageCount === 0) return null;

  let standard = 0;
  let empty = 0;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (typeof label !== "string") return null;
    if (label === "") empty++;
    else if (label === String(i + 1)) standard++;
  }
  if (standard + empty === pageCount) return null;

  return labels.map((label, index) => (label === "" ? String(index + 1) : label));
}

/**
 * What to call the page at `pageIndex` — its label where there is one, its
 * ordinary number otherwise.
 *
 * The single display answer. Note that labels are **not unique**: a document
 * whose front matter runs 1–12 and whose body restarts at 1 has two pages
 * called "1", which is a property of the format rather than a bug to fix. It
 * matters only in the other direction — resolving a typed label back to a page
 * takes the first match (pdfjs's `pageLabelToPageNumber` does the same).
 */
export function pageLabelFor(labels: readonly string[] | null, pageIndex: number): string {
  return labels?.[pageIndex] ?? String(pageIndex + 1);
}
