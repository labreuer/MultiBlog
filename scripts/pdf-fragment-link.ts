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
//     sheet number is the usual cause. Given as a printed page (`--label`), it
//     looks on every sheet carrying that label first, then on the first one's
//     neighbours.
//   - **It prints whichever form the file takes** (§8): `p=` with the printed
//     page where the file has usable labels, and `page=` where it has none,
//     where the sheet's own label is empty, or where an earlier sheet with
//     the same label holds the passage.
//   - **A quote across a page break comes back as two passages**, split
//     where the break falls, which the page's folio and running head would
//     otherwise hide (§5).
//
// A quote elided with "…" or "..." is read as its first words and its last,
// the `start,end` form, and nothing between them is matched.
//
// Read-only, and it reads as the operator, like the integrity check.
//
// Usage:
//   npx tsx scripts/pdf-fragment-link.ts <file-slug> <page> "<quote>"
//   npx tsx scripts/pdf-fragment-link.ts <file-slug> --label <label> "<quote>"
//   <page> is the 1-based sheet number, as #page= takes it; <label> is the
//   page printed on it, as #p= takes it.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { FragmentChecker } from "../src/lib/pdf-fragment-check";
import { checkPassage, type FilePages } from "../src/lib/pdf-fragment-findings";
import {
  countPassageOccurrences,
  formatFragmentPassages,
  fragmentWords,
  resolvePassage,
  splitAcrossPages,
  writerForm,
  type FragmentPassage,
  type PassageText,
  type TextRange,
} from "../src/lib/pdf-fragment";
import type { PageName } from "../src/lib/pdf-open-params";
import { pageNameForSheet, sheetsLabelled, usablePageLabels } from "../src/lib/pdf-page-labels";

type Located = { pageIndex: number; range: TextRange };

/** The quote as a passage to look for: whole, or its two ends when it is elided. */
function passageFor(quote: string): PassageText {
  const [start, ...rest] = quote.split(/\s*(?:…|\.\.\.)\s*/);
  const end = rest.length > 0 ? rest[rest.length - 1] : null;
  return { prefix: null, start, end: end && end.trim() ? end : null, suffix: null };
}

/** Where the passage is: the sheets given, the first one's neighbours, or the one page in the file that holds it once. */
function locate(file: FilePages, sheets: readonly number[], passage: PassageText): Located | null {
  const candidates = sheets.length > 0 ? [...new Set([...sheets, sheets[0] - 1, sheets[0] + 1])] : [];
  for (const candidate of candidates) {
    const page = file.pages.get(candidate);
    const range = page ? resolvePassage(page.text, passage, page.skeleton) : null;
    if (range) return { pageIndex: candidate, range };
  }
  let found: Located | null = null;
  for (const [candidate, page] of file.pages) {
    const count = countPassageOccurrences(page.text, passage, page.skeleton);
    if (count === 0) continue;
    if (count > 1 || found) return null;
    found = { pageIndex: candidate, range: resolvePassage(page.text, passage, page.skeleton)! };
  }
  return found;
}

/**
 * The writer's form of a located passage, in the author's own words where
 * they reach the same range (a corrected copy's "imagination" rather than the
 * page's "imagin ation"), and the page's otherwise.
 */
function formFor(text: string, located: Located, passage: PassageText): PassageText | null {
  if (passage.end === null) {
    return writerForm(text, located.range, fragmentWords(passage.start)) ?? writerForm(text, located.range);
  }
  const startWords = fragmentWords(passage.start);
  const endWords = fragmentWords(passage.end);
  for (let k = 3; k <= Math.max(startWords.length, endWords.length); k++) {
    const candidate: PassageText = {
      prefix: null,
      start: startWords.slice(0, k).join(" "),
      end: endWords.slice(-k).join(" "),
      suffix: null,
    };
    const range = resolvePassage(text, candidate);
    if (range && range.start === located.range.start && range.end === located.range.end) return candidate;
  }
  return writerForm(text, located.range);
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

type Printed = { passage: FragmentPassage; pageIndex: number; text: string; occurrences: number };

function print(file: FilePages, passages: Printed[], asked: readonly number[], askedText: string): void {
  console.log(`/pdf/${file.slug}#${formatFragmentPassages(passages.map((p) => p.passage))}`);
  for (const { pageIndex, text, occurrences } of passages) {
    console.log(`  ${sheetText(file, pageIndex)}: "${text}"`);
    if (occurrences > 1) console.log(`  warn: this form occurs ${occurrences} times on its page; the link points at the first`);
  }
  if (!asked.includes(passages[0].pageIndex)) console.log(`  note: found on ${sheetText(file, passages[0].pageIndex)}, not ${askedText}`);
}

const USAGE = 'Usage: npx tsx scripts/pdf-fragment-link.ts <file-slug> <page> "<quote>"\n       npx tsx scripts/pdf-fragment-link.ts <file-slug> --label <label> "<quote>"';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const byLabel = args[1] === "--label";
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
  const askedText = "sheet" in askedName ? `page ${askedName.sheet}` : `the page labelled ${askedName.label}`;
  if ("label" in askedName && asked.length === 0) console.error(`  note: no page of "${file.slug}" is labelled ${askedName.label}; looking in the whole file`);

  const passage = passageFor(quote);
  const located = locate(file, asked, passage);
  if (located) {
    const page = file.pages.get(located.pageIndex)!;
    const form = formFor(page.text, located, passage);
    if (form) {
      const range = resolvePassage(page.text, form, page.skeleton)!;
      print(
        file,
        [
          {
            passage: named(file, located.pageIndex, form),
            pageIndex: located.pageIndex,
            text: page.text.slice(range.start, range.end),
            occurrences: countPassageOccurrences(page.text, form, page.skeleton),
          },
        ],
        asked,
        askedText,
      );
      return 0;
    }
  }

  // Across a page break: the page given and the next, then the one before and it.
  if (passage.end === null && asked.length > 0) {
    for (const first of [asked[0], asked[0] - 1]) {
      const a = file.pages.get(first);
      const b = file.pages.get(first + 1);
      const split = a && b ? splitAcrossPages(a.text, b.text, quote) : null;
      if (!a || !b || !split) continue;
      const firstForm = writerForm(a.text, split.first, split.firstWords) ?? writerForm(a.text, split.first);
      const nextForm = writerForm(b.text, split.next, split.nextWords) ?? writerForm(b.text, split.next);
      if (!firstForm || !nextForm) continue;
      print(
        file,
        [
          { passage: named(file, first, firstForm), pageIndex: first, text: a.text.slice(split.first.start, split.first.end), occurrences: 1 },
          { passage: named(file, first + 1, nextForm), pageIndex: first + 1, text: b.text.slice(split.next.start, split.next.end), occurrences: 1 },
        ],
        asked,
        askedText,
      );
      return 0;
    }
  }

  const finding = checkPassage(file, { page: askedName, ...passage });
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
