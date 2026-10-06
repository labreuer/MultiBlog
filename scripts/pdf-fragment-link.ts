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
//     sheet number is the usual cause.
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
//   <page> is the 1-based sheet number, as #page= takes it.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { FragmentChecker, checkPassage, type FilePages } from "../src/lib/pdf-fragment-check";
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

type Located = { pageIndex: number; range: TextRange };

/** The quote as a passage to look for: whole, or its two ends when it is elided. */
function passageFor(quote: string): PassageText {
  const [start, ...rest] = quote.split(/\s*(?:…|\.\.\.)\s*/);
  const end = rest.length > 0 ? rest[rest.length - 1] : null;
  return { prefix: null, start, end: end && end.trim() ? end : null, suffix: null };
}

/** Where the passage is: the page given, its neighbours, or the one page in the file that holds it once. */
function locate(file: FilePages, pageIndex: number, passage: PassageText): Located | null {
  for (const candidate of [pageIndex, pageIndex - 1, pageIndex + 1]) {
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

function print(slug: string, passages: { passage: FragmentPassage; text: string; occurrences: number }[], askedPage: number): void {
  console.log(`/pdf/${slug}#${formatFragmentPassages(passages.map((p) => p.passage))}`);
  for (const { passage, text, occurrences } of passages) {
    console.log(`  page ${passage.page}: "${text}"`);
    if (occurrences > 1) console.log(`  warn: this form occurs ${occurrences} times on page ${passage.page}; the link points at the first`);
  }
  if (passages[0].passage.page !== askedPage) console.log(`  note: found on page ${passages[0].passage.page}, not ${askedPage}`);
}

async function main(): Promise<number> {
  const [slug, pageArg, quote] = process.argv.slice(2);
  if (!slug || !pageArg || !quote || !/^\d+$/.test(pageArg) || Number(pageArg) < 1) {
    console.error('Usage: npx tsx scripts/pdf-fragment-link.ts <file-slug> <page> "<quote>"');
    return 2;
  }
  const askedPage = Number(pageArg);

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

  const passage = passageFor(quote);
  const located = locate(file, askedPage - 1, passage);
  if (located) {
    const page = file.pages.get(located.pageIndex)!;
    const form = formFor(page.text, located, passage);
    if (form) {
      const full: FragmentPassage = { page: located.pageIndex + 1, ...form };
      const range = resolvePassage(page.text, form, page.skeleton)!;
      print(file.slug, [{ passage: full, text: page.text.slice(range.start, range.end), occurrences: countPassageOccurrences(page.text, form, page.skeleton) }], askedPage);
      return 0;
    }
  }

  // Across a page break: the page given and the next, then the one before and it.
  if (passage.end === null) {
    for (const first of [askedPage - 1, askedPage - 2]) {
      const a = file.pages.get(first);
      const b = file.pages.get(first + 1);
      const split = a && b ? splitAcrossPages(a.text, b.text, quote) : null;
      if (!a || !b || !split) continue;
      const firstForm = writerForm(a.text, split.first, split.firstWords) ?? writerForm(a.text, split.first);
      const nextForm = writerForm(b.text, split.next, split.nextWords) ?? writerForm(b.text, split.next);
      if (!firstForm || !nextForm) continue;
      print(
        file.slug,
        [
          { passage: { page: first + 1, ...firstForm }, text: a.text.slice(split.first.start, split.first.end), occurrences: 1 },
          { passage: { page: first + 2, ...nextForm }, text: b.text.slice(split.next.start, split.next.end), occurrences: 1 },
        ],
        askedPage,
      );
      return 0;
    }
  }

  const finding = checkPassage(file, { page: askedPage, ...passage });
  if (finding.kind === "page-out-of-range") {
    console.error(`Page ${askedPage} is past the end: "${file.slug}" has ${finding.pageCount} pages.`);
  } else if (finding.kind === "no-match") {
    console.error(`Not found on page ${askedPage}, its neighbours, or exactly once anywhere else in the file.`);
    if (finding.matchedUpTo !== null) {
      console.error(`  On page ${askedPage} it matches up to "…${finding.matchedUpTo}", where the page has "${finding.pageHasThere}…".`);
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
