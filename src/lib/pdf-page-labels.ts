import type { PageForm, PageName } from "./pdf-open-params";

// PLAN.md §19c — page labels: what a PDF calls its own pages.
//
// A page's *index* is where it sits in the file; its **label** is what is
// printed on it. In anything with front matter they differ — "iv" is the fourth
// sheet, "1" is the twelfth — and the label is the one the reader can act on,
// because it is what the contents page, the index and the citation all say.
//
// Indices stay 1-based everywhere internally (pdfjs's own API is, our anchors
// are, presence is). A label is **displayed and looked up**, never counted
// with: one function answers "what do we call this page", and every surface
// that shows a page number calls it; one rule answers "which sheet is printed
// page 49" for a link or a citation (`sheetsLabelled`, below).

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

// ---------------------------------------------------------------------------
// docs/MCP.md §8 — labels as a machine client reads them: as ranges, where a
// run of sheets whose labels count up by one, in one style and with one
// prefix, is one entry and any other label stands alone. For a 471-page book
// with roman front matter that is 28 tokens, against 948 for one string per
// page.

type LabelStyle = { prefix: string; kind: "arabic" | "roman" | "ROMAN"; value: number } | null;

const ROMAN = [
  ["m", 1000],
  ["cm", 900],
  ["d", 500],
  ["cd", 400],
  ["c", 100],
  ["xc", 90],
  ["l", 50],
  ["xl", 40],
  ["x", 10],
  ["ix", 9],
  ["v", 5],
  ["iv", 4],
  ["i", 1],
] as const;

function toRoman(n: number): string {
  let out = "";
  for (const [glyph, value] of ROMAN) {
    while (n >= value) {
      out += glyph;
      n -= value;
    }
  }
  return out;
}

function fromRoman(text: string): number | null {
  const lower = text.toLowerCase();
  if (!/^[mdclxvi]+$/.test(lower)) return null;
  let n = 0;
  let rest = lower;
  for (const [glyph, value] of ROMAN) {
    while (rest.startsWith(glyph)) {
      n += value;
      rest = rest.slice(glyph.length);
    }
  }
  // Only the canonical spelling counts, so "iiii" isn't four.
  return toRoman(n) === lower ? n : null;
}

/** A label's prefix, numbering style and value, or null for one that isn't a counted label. */
export function labelStyle(label: string): LabelStyle {
  const arabic = /^(.*?)(\d+)$/.exec(label);
  if (arabic) return { prefix: arabic[1], kind: "arabic", value: Number(arabic[2]) };
  // A roman numeral's prefix ends in something other than a letter, or
  // "Index" would read as "Inde" and ten.
  const roman = /^(.*[^A-Za-z])?([ivxlcdm]+|[IVXLCDM]+)$/.exec(label);
  if (roman) {
    const value = fromRoman(roman[2]);
    if (value !== null) {
      return { prefix: roman[1] ?? "", kind: roman[2] === roman[2].toLowerCase() ? "roman" : "ROMAN", value };
    }
  }
  return null;
}

/** A run of sheets and the printed pages on them, in MCP's two words (docs/MCP.md §8). */
export type LabelRange = { sheets: string; pages: string };

/**
 * Labels as ranges: each run of sheets whose labels count up by one, in one
 * style with one prefix, is one entry; any other label stands alone.
 */
export function labelRanges(labels: readonly string[]): LabelRange[] {
  const ranges: LabelRange[] = [];
  let start = 0;
  while (start < labels.length) {
    const first = labelStyle(labels[start]);
    let end = start;
    if (first) {
      while (end + 1 < labels.length) {
        const next = labelStyle(labels[end + 1]);
        if (!next || next.kind !== first.kind || next.prefix !== first.prefix || next.value !== first.value + (end + 1 - start)) break;
        end++;
      }
    }
    ranges.push({
      sheets: start === end ? String(start + 1) : `${start + 1}-${end + 1}`,
      pages: start === end ? labels[start] : `${labels[start]}-${labels[end]}`,
    });
    start = end + 1;
  }
  return ranges;
}

/**
 * Every 0-based page carrying `label`, trimmed and in any case — labels are
 * not unique, so front matter and body can both have a "1". Without labels, a
 * plain number is its own page.
 */
export function pagesLabelled(labels: readonly string[] | null, label: string): number[] {
  const wanted = label.trim().toLowerCase();
  if (!labels) return /^\d+$/.test(wanted) ? [Number(wanted) - 1] : [];
  if (!wanted) return [];
  return labels.flatMap((l, index) => (l.trim().toLowerCase() === wanted ? [index] : []));
}

// ---------------------------------------------------------------------------
// docs/PDF_FRAGMENT_LINKS.md §2, "Which sheet" — a printed page as a link
// names it (`p=<label>`), and as a citation's page does: the one rule both
// find a sheet by, so a citation and a `p=` link of the same page land on the
// same sheet.
//
// **`ownLabels` are the labels the file itself gives**, one per sheet, as
// pdfjs's `getPageLabels()` reads them and `file_version.page_labels` stores
// them — never `usablePageLabels`' copy, whose empty labels are filled with
// their sheet's number for the page box. A filled-in number is not a label, so on a
// labelled file `p=5` never names a sheet whose own label is empty; only
// `sheet=` names such a sheet.

/**
 * The 0-based sheets the printed page `label` names, in order. On a file with
 * usable labels, every sheet whose own label it is; on a file without them,
 * sheet N for a label N in digits, as a citation's page is read on such a
 * file, and nothing for any other label. Empty when no sheet carries it.
 */
export function sheetsLabelled(ownLabels: readonly string[] | null | undefined, pageCount: number, label: string): number[] {
  if (ownLabels && usablePageLabels(ownLabels, pageCount)) return pagesLabelled(ownLabels, label);
  const wanted = label.trim();
  if (!/^\d+$/.test(wanted)) return [];
  const sheet = Number(wanted);
  return sheet >= 1 && sheet <= pageCount ? [sheet - 1] : [];
}

/**
 * The 0-based sheets a fragment's page names, in order: a sheet past the end
 * names none, as a label no sheet carries names none.
 */
export function sheetsNamed(page: PageName, ownLabels: readonly string[] | null | undefined, pageCount: number): number[] {
  if ("sheet" in page) return page.sheet <= pageCount ? [page.sheet - 1] : [];
  return sheetsLabelled(ownLabels, pageCount, page.label);
}

/**
 * The form a writer names the sheet at 0-based `sheetIndex` in
 * (PDF_FRAGMENT_LINKS.md §8), to which it adds its stamp (`formatPageName`): `p=` with its own label where the file has usable labels, and `sheet=`
 * where it has none, where a `p=` would turn into a printed page the day the
 * file gained labels. Also `sheet=` for a sheet whose own label is empty,
 * which no `p` names, and where an earlier sheet carrying the same label
 * `holds` what the link names, since a `p=` would find it there first.
 *
 * For a passage, `holds` says whether an earlier sheet holds the passage as
 * written. A page link has no passage and opens at the first sheet carrying
 * its label, so by default every earlier sheet holds it: a search hit writes
 * `p=` only when its sheet is the first carrying its label.
 */
export function pageNameForSheet(
  ownLabels: readonly string[] | null | undefined,
  pageCount: number,
  sheetIndex: number,
  holds: (earlierSheet: number) => boolean = () => true,
): PageForm {
  const own = ownLabels?.[sheetIndex]?.trim();
  if (!own || !usablePageLabels(ownLabels, pageCount)) return { sheet: sheetIndex + 1 };
  const earlier = pagesLabelled(ownLabels!, own).filter((index) => index < sheetIndex);
  return earlier.some(holds) ? { sheet: sheetIndex + 1 } : { label: own };
}

/**
 * How a writer names the printed page `label` in a link that has no passage,
 * the cited-page redirect's: `p=` with the label as the file gives it, on a
 * file with usable labels; `sheet=` with its sheet on one without, where
 * `p=` would turn into a printed page the day the file gained labels. Null
 * when no sheet carries it.
 */
export function pageNameForLabel(ownLabels: readonly string[] | null | undefined, pageCount: number, label: string): PageForm | null {
  const sheets = sheetsLabelled(ownLabels, pageCount, label);
  if (sheets.length === 0) return null;
  return ownLabels && usablePageLabels(ownLabels, pageCount) ? { label: ownLabels[sheets[0]].trim() } : { sheet: sheets[0] + 1 };
}
