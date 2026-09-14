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
 *   screen — the box would show the same number and {@link pageTotalLabel}
 *   would land on the same total — while switching on the chrome that exists to
 *   explain a label: a "Sheet 4 of 6" title on a box already showing 4. So it is
 *   treated as absent.
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

/** How far back from the end to look for a number. See `pageTotalLabel`. */
const TAIL_WINDOW = 5;

/**
 * What to put after "Page N of" — the document's own last *numbered* page where
 * it has one, and the sheet count otherwise.
 *
 * The box beside it shows a label, so the total should be its counterpart: in a
 * book with twelve sheets of front matter, "Page 1 of 350" is a pair a reader
 * can act on and "Page 1 of 362" is not.
 *
 * **The last label is not the answer**, though, because the end of a document
 * is where the labels stop being numbers: an index, a colophon, an appendix
 * running `A-1`… Reporting "of A-12" names no quantity at all, and it is the
 * common shape rather than an exotic one. So the last {@link TAIL_WINDOW} pages
 * are searched from the back for a plain integer, and the first one found wins.
 * Five because back matter is short — a window wide enough to tunnel through a
 * whole unnumbered appendix would start answering with a body page number,
 * which is worse than the sheet count: it reads authoritative and undercounts.
 *
 * Nothing integral in that window means the tail is entirely unnumbered, and
 * the sheet count is the only honest number left. Note that the blanks
 * {@link usablePageLabels} fills in are ordinary numbers, so a document whose
 * last pages carry no label at all resolves to the sheet count by that path
 * too, arriving at the same answer from the other direction.
 */
export function pageTotalLabel(labels: readonly string[] | null, pageCount: number): string {
  // Trusted only where it lines up with the pages, which is the same condition
  // usablePageLabels enforces on the way in — a labels array of some other
  // length belongs to a document this one has since been replaced by.
  if (labels?.length === pageCount) {
    const stop = Math.max(0, pageCount - TAIL_WINDOW);
    for (let i = pageCount - 1; i >= stop; i--) {
      if (/^\d+$/.test(labels[i])) return labels[i];
    }
  }
  return String(pageCount);
}
