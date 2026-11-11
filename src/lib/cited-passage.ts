import { citedPages, parseCitedQuery, type CitedHref } from "./cited-passage-query";
import { formatFragmentPassages, resolvePassage, type PassageText } from "./pdf-fragment";
import { FragmentChecker } from "./pdf-fragment-check";
import { checkPassage, parseFragmentLinkHref, type FilePages, type FragmentLinkFinding } from "./pdf-fragment-findings";
import { pageNameForSheet, sheetsLabelled } from "./pdf-page-labels";
import { passagePieces, withoutBrackets, type PlacedPassage } from "./pdf-passage-pieces";
import { prisma } from "./prisma";
import { referenceByKey } from "./reference-data";
import { parseReferenceSegment } from "./references/keys";

// docs/CITATIONS.md, "The link" — a citation's passage against its work's
// PDF: where the cited-page route sends a reader who may open it, and what
// the integrity check and MCP's write check confirm, all through
// `passagePieces` over the stored page text, so the three agree.
//
// Server-only, and it reads as the operator, as FragmentChecker does: a
// front door that reads as a user (the route, MCP's write check) asks the
// files' read rule first.

/** How far a quotation may run from a sheet: onto the sheets up to the locator's last page, never past eight. */
function throughFor(lastSheets: readonly number[] | null): (start: number) => number {
  return (start) => (lastSheets ? (lastSheets.find((sheet) => sheet >= start) ?? start) : start);
}

/**
 * Where a quotation is in a PDF, starting on the sheets the cited page's
 * first label names and running on, for a locator of several pages, as far
 * as its last: the pieces `passagePieces` places, null when it places none,
 * and the sheets it started from. `ownLabels` are the file's own.
 */
export async function placeCitedQuotation(
  checker: FragmentChecker,
  file: { id: string; pageCount: number; ownLabels: readonly string[] | null },
  page: string,
  text: PassageText,
): Promise<{ starts: number[]; placed: PlacedPassage[] | null; pages: FilePages | null }> {
  const pages = citedPages(page);
  if (!pages) return { starts: [], placed: null, pages: null };
  const starts = sheetsLabelled(file.ownLabels, file.pageCount, pages.first);
  const lastSheets = pages.last === pages.first ? null : sheetsLabelled(file.ownLabels, file.pageCount, pages.last);
  const through = throughFor(lastSheets);
  const indexes = [...new Set(starts.flatMap((start) => Array.from({ length: Math.min(through(start), start + 7) - start + 1 }, (_, i) => start + i)))];
  const filePages = await checker.pagesAt(file.id, indexes);
  if (!filePages || starts.length === 0) return { starts, placed: null, pages: filePages };
  return { starts, placed: passagePieces(text, filePages.pages, starts, through), pages: filePages };
}

/** The fragment for placed pieces: each on its sheet, named as a writer names it (docs/PDF_FRAGMENT_LINKS.md §8). */
export function placedFragment(placed: readonly PlacedPassage[], pages: FilePages): string {
  return formatFragmentPassages(
    placed.map((piece) => ({
      page: pageNameForSheet(pages.ownLabels, pages.pageCount, piece.sheet, (earlier) => {
        const held = pages.pages.get(earlier);
        return held !== undefined && resolvePassage(held.text, piece.passage, held.skeleton) !== null;
      }),
      ...piece.passage,
    })),
  );
}

/** What a citation's passage comes to against its work's PDF. */
export type CitedFinding =
  | { kind: "unknown-work"; key: string }
  /** The work has no live PDF, so the passage is never shown. */
  | { kind: "no-pdf"; key: string }
  /** A PDF the reader the check reads for may not open: nothing is said about it. */
  | { kind: "unreadable-pdf"; key: string }
  | { kind: "unreadable-query"; key: string }
  /** No sheet carries the cited page. */
  | { kind: "no-such-page"; key: string; page: string }
  /** A `/pdf/` referent's pairs, checked as the fragment link they make in the work's PDF. */
  | { kind: "fragment"; key: string; slug: string; finding: FragmentLinkFinding }
  /** A quotation found: its pieces, 1-based sheets. */
  | { kind: "placed"; key: string; passages: (PlacedPassage & { text: string })[] }
  /** A quotation the cited page doesn't hold, with where it stops matching on the first sheet that page names. */
  | { kind: "missed"; key: string; sheet: number; matchedUpTo: string | null; pageHasThere: string | null; foundOnPage: number | null }
  /** Nothing in the query names a passage. */
  | { kind: "none"; key: string };

/**
 * A citation's link at a page with a query, against its work's PDF: the
 * check the integrity script runs over every doc's citations and every
 * post's frozen links, and MCP's write check over what it writes. `canRead`
 * is the files' read rule for a front door that reads as a user.
 */
export async function checkCitedHref(
  checker: FragmentChecker,
  href: CitedHref,
  opts: { canRead?: (file: { id: string; visibility: "PRIVATE" | "SHARED" }) => Promise<boolean> } = {},
): Promise<CitedFinding> {
  const parsed = parseReferenceSegment(href.segment);
  const key = parsed && parsed.kind !== "list" ? parsed.key : href.segment;
  const reference = parsed && parsed.kind !== "list" ? await referenceByKey(parsed.key) : null;
  if (!reference) return { kind: "unknown-work", key };
  const file =
    reference.fileId && !reference.deleted
      ? await prisma.storedFile.findFirst({
          where: { id: reference.fileId, deletedByUserId: null },
          select: { id: true, slug: true, visibility: true, pageCount: true },
        })
      : null;
  if (!file || file.pageCount === null) return { kind: "no-pdf", key: reference.key };
  if (opts.canRead && !(await opts.canRead(file))) return { kind: "unreadable-pdf", key: reference.key };

  const query = parseCitedQuery(href.query);
  if (query.kind === "none") return { kind: "none", key: reference.key };
  if (query.kind === "unreadable") return { kind: "unreadable-query", key: reference.key };
  if (query.kind === "pairs") {
    const link = parseFragmentLinkHref(`/pdf/${file.slug}#${query.fragment}`, null);
    if (!link) return { kind: "unreadable-query", key: reference.key };
    return { kind: "fragment", key: reference.key, slug: file.slug, finding: await checker.check(link) };
  }

  // The file's own labels, read from its bytes and not stored where they haven't been read yet, as the check reads them.
  const ownLabels = (await checker.pagesAt(file.id, []))?.ownLabels ?? null;
  const { starts, placed, pages } = await placeCitedQuotation(checker, { id: file.id, pageCount: file.pageCount, ownLabels }, href.page, query.text);
  if (starts.length === 0 || !pages) return { kind: "no-such-page", key: reference.key, page: href.page };
  if (placed) {
    return {
      kind: "placed",
      key: reference.key,
      passages: placed.map((piece) => ({ ...piece, sheet: piece.sheet + 1, text: pages.pages.get(piece.sheet)!.text.slice(piece.range.start, piece.range.end) })),
    };
  }
  const miss = checkPassage(pages, { page: { sheet: starts[0] + 1 }, ...withoutBrackets(query.text) });
  return {
    kind: "missed",
    key: reference.key,
    sheet: starts[0] + 1,
    matchedUpTo: miss.kind === "no-match" ? miss.matchedUpTo : null,
    pageHasThere: miss.kind === "no-match" ? miss.pageHasThere : null,
    foundOnPage: miss.kind === "no-match" ? miss.foundOnPage : null,
  };
}
