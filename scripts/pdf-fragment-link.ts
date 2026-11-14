// Prints the fragment link for one quote from a PDF, or why there isn't one
// (docs/PDF_FRAGMENT_LINKS.md §8).
//
// For checking a quote before writing it into a doc. Writing one needs nothing
// from the instance: an author quoting from a corrected extraction writes the
// writer's form straight into the Markdown. This is the same check
// scripts/integrity/check-pdf-fragment-links.ts runs, for one quote, plus the
// two things an author can't easily do by hand:
//
//   - **The page is a hint.** It looks on the page given, then on its two
//     neighbours, then anywhere in the file, and uses the page the quote is on
//     when that is unambiguous. A printed page number given by mistake for a
//     sheet number is the usual cause. Given as a printed page (`--page`), it
//     looks on every sheet carrying that label first, then on the first one's
//     neighbours.
//   - **It prints whichever form the file takes** (§8): `p=` with the printed
//     page where the file has usable labels, and `sheet=` where it has none,
//     where the sheet's own label is empty, or where an earlier sheet with
//     the same label holds the passage.
//   - **A quote across a page break comes back as two passages**, split
//     where the break falls, which the page's folio and running head would
//     otherwise hide (§5).
//
// A quote elided with "…" or "..." is read with its words left out (§2): its
// segments, in order, each the first match after the one before it. A
// bracket standing alone is a gap too, and one attached to a word is tried
// with its letters and without, as a citation's passage is
// (src/lib/pdf-passage-pieces.ts).
//
// Read-only, and it reads as the operator, like the integrity check.
//
// Usage:
//   npx tsx scripts/pdf-fragment-link.ts <file-slug> <sheet> "<quote>"
//   npx tsx scripts/pdf-fragment-link.ts <file-slug> --page <label> "<quote>"
//   <sheet> is the 1-based sheet number, as #sheet= takes it; <label> is the
//   page printed on it, as #p= takes it. `--label` is read as `--page`.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { FragmentChecker } from "../src/lib/pdf-fragment-check";
import { checkPassage, type FilePages } from "../src/lib/pdf-fragment-findings";
import { formatFragmentPassages, parsePassageText, resolvePassage, type FragmentPassage, type PassageText } from "../src/lib/pdf-fragment";
import { passagePieces, quotationText, withoutBrackets, type PlacedPassage } from "../src/lib/pdf-passage-pieces";
import type { PageName } from "../src/lib/pdf-open-params";
import { pageNameForSheet, sheetsLabelled, usablePageLabels } from "../src/lib/pdf-page-labels";

/** The quote as a `text` value: its words left out marked as gaps, its brackets still to settle (src/lib/pdf-passage-pieces.ts). */
function passageFor(quote: string): PassageText | null {
  const text = quotationText(quote, { shorten: false });
  return text === null ? null : parsePassageText(text);
}

/** Where the passage is on one page: the sheets given, the first one's neighbours, or the one page in the file that holds it once. */
function locate(file: FilePages, sheets: readonly number[], passage: PassageText): PlacedPassage | null {
  const candidates = sheets.length > 0 ? [...new Set([...sheets, sheets[0] - 1, sheets[0] + 1])] : [];
  for (const candidate of candidates) {
    const found = passagePieces(passage, file.pages, [candidate]);
    if (found) return found[0];
  }
  let found: PlacedPassage | null = null;
  for (const candidate of file.pages.keys()) {
    const pieces = passagePieces(passage, file.pages, [candidate]);
    if (!pieces) continue;
    if (pieces[0].occurrences > 1 || found) return null;
    found = pieces[0];
  }
  return found;
}

/** A located passage as the link names it: its page in whichever form the file takes (§8). */
function named(file: FilePages, pageIndex: number, form: PassageText): FragmentPassage {
  const page = pageNameForSheet(file.ownLabels, file.pageCount, pageIndex, (earlier) => {
    const text = file.pages.get(earlier);
    return text !== undefined && resolvePassage(text.text, form, text.skeleton) !== null;
  });
  return { page, ...form };
}

/** A sheet as the output names it: its number, and its own label where the file has usable ones. */
function sheetText(file: FilePages, pageIndex: number): string {
  const own = usablePageLabels(file.ownLabels, file.pageCount) ? file.ownLabels?.[pageIndex]?.trim() : "";
  return own ? `page ${pageIndex + 1} (labelled ${own})` : `page ${pageIndex + 1}`;
}

function print(file: FilePages, passages: readonly PlacedPassage[], asked: readonly number[], askedText: string): void {
  console.log(`/pdf/${file.slug}#${formatFragmentPassages(passages.map((p) => named(file, p.sheet, p.passage)))}`);
  for (const { sheet, range, occurrences } of passages) {
    console.log(`  ${sheetText(file, sheet)}: "${file.pages.get(sheet)!.text.slice(range.start, range.end)}"`);
    if (occurrences > 1) console.log(`  warn: this form occurs ${occurrences} times on its page; the link points at the first`);
  }
  if (!asked.includes(passages[0].sheet)) console.log(`  note: found on ${sheetText(file, passages[0].sheet)}, not ${askedText}`);
}

const USAGE = 'Usage: npx tsx scripts/pdf-fragment-link.ts <file-slug> <sheet> "<quote>"\n       npx tsx scripts/pdf-fragment-link.ts <file-slug> --page <label> "<quote>"   (or --label <label>)';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  // `--page` in MCP's and the links' sense, the printed page; `--label` is its older name, kept for what already calls it.
  const byLabel = args[1] === "--page" || args[1] === "--label";
  const [slug, pageArg, quote] = byLabel ? [args[0], args[2], args[3]] : args;
  if (!slug || !pageArg?.trim() || !quote || (!byLabel && (!/^\d+$/.test(pageArg) || Number(pageArg) < 1))) {
    console.error(USAGE);
    return 2;
  }
  const askedName: PageName = byLabel ? { label: pageArg.trim() } : { sheet: Number(pageArg) };

  const checker = new FragmentChecker();
  const file = await checker.pagesFor(slug);
  if (!file) {
    console.error(`No live PDF has the slug "${slug}".`);
    return 1;
  }
  if (file.pages.size === 0) {
    console.error(`"${file.slug}" has no stored page text.`);
    return 1;
  }

  // The sheets the page names: one for a sheet; every sheet carrying a label.
  const asked = "sheet" in askedName ? [askedName.sheet - 1] : sheetsLabelled(file.ownLabels, file.pageCount, askedName.label);
  const askedText = "sheet" in askedName ? `sheet ${askedName.sheet}` : `page ${askedName.label}`;
  if ("label" in askedName && asked.length === 0) console.error(`  note: no page of "${file.slug}" is labelled ${askedName.label}; looking in the whole file`);

  const passage = passageFor(quote);
  if (!passage) {
    console.error("The quote has no words to look for.");
    return 2;
  }
  const located = locate(file, asked, passage);
  if (located) {
    print(file, [located], asked, askedText);
    return 0;
  }

  // Across a page break: the page given and the next, then the one before and it.
  for (const first of asked.length > 0 ? [asked[0], asked[0] - 1] : []) {
    const pieces = passagePieces(passage, file.pages, [first], (start) => start + 1);
    if (!pieces) continue;
    print(file, pieces, asked, askedText);
    return 0;
  }

  const finding = checkPassage(file, { page: askedName, ...withoutBrackets(passage) });
  if (finding.kind === "page-out-of-range") {
    console.error(`${askedText[0].toUpperCase()}${askedText.slice(1)} is past the end: "${file.slug}" has ${finding.pageCount} pages.`);
  } else if (finding.kind === "no-such-label") {
    console.error(`No page is labelled ${pageArg.trim()}, and the quote isn't exactly once anywhere in the file.`);
  } else if (finding.kind === "no-match") {
    console.error(`Not found on ${askedText}, its neighbours, or exactly once anywhere else in the file.`);
    if (finding.matchedUpTo !== null) {
      console.error(`  On ${sheetText(file, finding.sheets[0] - 1)} it matches up to "…${finding.matchedUpTo}", where the page has "${finding.pageHasThere}…".`);
    }
  }
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
