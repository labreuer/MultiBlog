import { prisma } from "@/lib/prisma";
import { currentTextVersion } from "@/lib/pdf-extract";
import { storedPageText } from "@/lib/pdf-page-text";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { labelRanges, pagesLabelled, sheetsLabelled, sheetsNamed, usablePageLabels } from "@/lib/pdf-page-labels";
import { pageFromHash, type PageName } from "@/lib/pdf-open-params";
import { onePassage, parseFragmentPassages, passageWords, resolveAll, resolvePassage, skeletonOf, type PassageText } from "@/lib/pdf-fragment";
import { checkPassage, type FilePages } from "@/lib/pdf-fragment-findings";
import { overlapWindows } from "@/lib/comment-quote-match";
import { markdownToText } from "@/lib/markdown-import";
import { tagsForTarget } from "@/lib/tag-data";
import type { StoredOutlineEntry } from "@/lib/pdf-extract";
import { ApiError, ERROR_LIST_CAP, invalid } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "../tool";
import { dayOf } from "../shape";
import type { ResolvedFile } from "../resolve";
import { fragmentParams } from "../url";
import { readBoundFor, type ReadArgs } from "./args";

// docs/MCP.md §8 — reading a PDF: the file itself (title, page count, labels
// as ranges, outline, tags), a page or a run of pages, every page carrying a
// label, an outline entry's pages, every occurrence of a quote with its
// surroundings, and a fragment link read as its passage.
//
// **Numbering.** A tool's `page` is the 1-based sheet number, as `#page=` and
// search's hits use it; responses carry the label beside it wherever the PDF
// has usable ones. Labels are a lookup, never a coordinate.

/** About this much of the page either side of a quote or a fragment link's passage. */
const SURROUNDINGS = 300;

/** A version's page text at the current text version, extracting it once on a miss (storedPageText). */
export async function pageTexts(fileVersionId: string, pageIndexes: readonly number[]): Promise<Map<number, string>> {
  const version = await currentTextVersion();
  const read = () =>
    prisma.filePageText.findMany({
      where: { fileVersionId, textVersion: version, pageIndex: { in: [...pageIndexes] } },
      select: { pageIndex: true, text: true },
    });
  let rows = await read();
  if (rows.length < pageIndexes.length && pageIndexes.length > 0) {
    await storedPageText(fileVersionId, pageIndexes[0], version);
    rows = await read();
  }
  return new Map(rows.map((row) => [row.pageIndex, row.text]));
}

function allPages(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index);
}

/** The outline as a read shows it: entries to a depth, each with its page, label and how many pages it spans. */
function outlineOf(
  entries: readonly StoredOutlineEntry[],
  labels: string[] | null,
  pageCount: number,
  opts: { depth?: number; within?: number },
) {
  const span = (index: number): { from: number; to: number } | null => {
    const entry = entries[index];
    if (entry.pageIndex === null) return null;
    let to = pageCount - 1;
    for (let k = index + 1; k < entries.length; k++) {
      const next = entries[k];
      if (next.depth <= entry.depth && next.pageIndex !== null) {
        to = Math.max(entry.pageIndex, next.pageIndex - 1);
        break;
      }
    }
    return { from: entry.pageIndex, to };
  };

  let first = 0;
  let last = entries.length;
  let base = 0;
  if (opts.within !== undefined) {
    first = opts.within;
    base = entries[first].depth;
    last = first + 1;
    while (last < entries.length && entries[last].depth > base) last++;
  }
  const keep = opts.depth === undefined ? Infinity : base + opts.depth - 1;
  const out: Record<string, unknown>[] = [];
  let deeper = 0;
  for (let index = first; index < last; index++) {
    const entry = entries[index];
    if (entry.depth > keep) {
      deeper++;
      continue;
    }
    const pages = span(index);
    out.push({
      depth: entry.depth + 1,
      title: entry.title,
      ...(pages
        ? {
            page: pages.from + 1,
            ...(labels ? { label: labels[pages.from] } : {}),
            pages: pages.to - pages.from + 1,
          }
        : {}),
    });
  }
  return { entries: out, ...(deeper > 0 ? { deeper } : {}), spanOf: span };
}

/** An outline entry by title; a title that occurs twice is refused, naming each. */
function findEntry(entries: readonly StoredOutlineEntry[], title: string): number {
  const wanted = title.replace(/\s+/g, " ").trim().toLowerCase();
  const found = entries.flatMap((entry, index) => (entry.title.toLowerCase() === wanted ? [index] : []));
  if (found.length === 0) throw new ApiError("not_found", `No outline entry is titled "${title}".`);
  if (found.length > 1) {
    throw new ApiError("ambiguous", `More than one outline entry is titled "${title}".`, {
      entries: found.slice(0, ERROR_LIST_CAP).map((index) => ({
        depth: entries[index].depth + 1,
        page: entries[index].pageIndex === null ? null : entries[index].pageIndex! + 1,
      })),
      total: found.length,
    });
  }
  return found[0];
}

/**
 * Pages as a read returns them, fitted to the token's bound: each with its sheet
 * number, its label and its text, and the next page to ask for when they don't
 * all fit.
 */
async function pagesResult(file: ResolvedFile, labels: string[] | null, indexes: number[], maxChars: number): Promise<ToolResult> {
  const texts = await pageTexts(file.versionId, indexes);
  const pages: Record<string, unknown>[] = [];
  let size = 0;
  let next: number | null = null;
  for (const index of indexes) {
    const entry = { page: index + 1, ...(labels ? { label: labels[index] } : {}), text: texts.get(index) ?? "" };
    const cost = JSON.stringify(entry).length;
    if (pages.length > 0 && size + cost > maxChars - 1000) {
      next = index + 1;
      break;
    }
    pages.push(entry);
    size += cost;
  }
  return { kind: "pdf-pages", url: file.url, pages, ...(next !== null ? { next } : {}) };
}

/** `1-based N` or `N-M` into 0-based page indexes, inside the file. */
function pageRange(spec: string, pageCount: number): number[] {
  const [a, b] = spec.split("-").map(Number);
  const from = a;
  const to = b ?? a;
  if (from < 1 || to < from || from > pageCount) {
    throw invalid(`This PDF has ${pageCount} pages; ${spec} isn't a range of them.`);
  }
  return Array.from({ length: Math.min(to, pageCount) - from + 1 }, (_, k) => from - 1 + k);
}

/** What the fragment names: a page (`#page=N`, or `#p=<label>` by printed page) and whether it has a fragment link's `text` parameters. */
function viewerFragment(fragment: string): { page: PageName | null; hasText: boolean } {
  const hasText = fragmentParams(fragment).some(([key]) => key === "text");
  return { page: pageFromHash(`#${fragment}`), hasText };
}

/** A page as an answer names it. */
function pageText(page: PageName): string {
  return "sheet" in page ? `page ${page.sheet}` : `the page labelled ${page.label}`;
}

export async function readPdf(ctx: McpContext, file: ResolvedFile, args: ReadArgs, fragment: string, extras: () => Promise<ToolResult>): Promise<ToolResult> {
  if (file.pageCount === null) return readPlainFile(file);
  for (const docOnly of ["since", "section", "from", "to", "whole"] as const) {
    if (args[docOnly] !== undefined) throw invalid(`${docOnly} is for a doc; a PDF reads by page, label or outline entry.`);
  }
  const metadata = await pdfMetadata(file.versionId);
  const labels = metadata ? usablePageLabels(metadata.pageLabels, file.pageCount) : null;
  // The labels the file itself gives, which a `p=` is matched against, never `labels`' filled-in copy.
  const ownLabels = metadata?.pageLabels ?? null;
  const pageCount = file.pageCount;
  const maxChars = readBoundFor(ctx.token.client);
  const { page: fragmentPage, hasText } = viewerFragment(fragment);

  if (hasText) return fragmentPassages(file, labels, ownLabels, fragment);
  if (args.around !== undefined) return { ...(await aroundQuote(file, labels, args)), ...(await extras()) };

  if (args.entry !== undefined) {
    const entries = metadata?.outline ?? [];
    const index = findEntry(entries, args.entry);
    const outline = outlineOf(entries, labels, pageCount, { depth: args.depth, within: index });
    if (args.outline) {
      return { kind: "pdf-outline", url: file.url, entries: outline.entries, ...(outline.deeper ? { deeper: outline.deeper } : {}) };
    }
    const span = outline.spanOf(index);
    if (!span) throw new ApiError("not_found", `The outline entry "${args.entry}" points at no page of this file.`);
    return pagesResult(file, labels, allPages(pageCount).slice(span.from, span.to + 1), maxChars);
  }

  const asked = [args.page !== undefined, args.pages !== undefined, args.label !== undefined].filter(Boolean).length;
  if (asked > 1) throw invalid("Name pages one way per read: page, pages or label.");
  if (args.label !== undefined) {
    const indexes = pagesLabelled(labels, args.label).filter((index) => index < pageCount);
    if (indexes.length === 0) throw new ApiError("not_found", `No page of this PDF is labelled "${args.label}".`);
    return pagesResult(file, labels, indexes, maxChars);
  }
  if (args.pages !== undefined) return pagesResult(file, labels, pageRange(args.pages, pageCount), maxChars);
  // A page link opens at the first sheet carrying its label, as the viewer does.
  if (args.page === undefined && fragmentPage !== null && "label" in fragmentPage) {
    const sheets = sheetsLabelled(ownLabels, pageCount, fragmentPage.label);
    if (sheets.length === 0) throw new ApiError("not_found", `No page of this PDF is labelled "${fragmentPage.label}".`);
    return pagesResult(file, labels, [sheets[0]], maxChars);
  }
  const page = args.page ?? (fragmentPage && "sheet" in fragmentPage ? fragmentPage.sheet : null);
  if (page !== null && page !== undefined) {
    if (page > pageCount) throw invalid(`This PDF has ${pageCount} pages.`);
    return pagesResult(file, labels, [page - 1], maxChars);
  }

  // The file itself.
  const [chips, row] = await Promise.all([
    tagsForTarget({ kind: "file", id: file.id }),
    prisma.storedFile.findUnique({ where: { id: file.id }, select: { updatedAt: true } }),
  ]);
  const outline = outlineOf(metadata?.outline ?? [], labels, pageCount, { depth: args.depth ?? 1 });
  return {
    kind: "pdf",
    id: file.id,
    url: file.url,
    title: file.title,
    filename: file.filename,
    visibility: file.visibility,
    pages: pageCount,
    ...(labels ? { labels: labelRanges(labels) } : {}),
    ...(outline.entries.length > 0 ? { outline: { entries: outline.entries, ...(outline.deeper ? { deeper: outline.deeper } : {}) } } : {}),
    ...(row ? { updated: dayOf(row.updatedAt) } : {}),
    ...(chips.length > 0 ? { tags: chips.map((chip) => ({ name: chip.name, slug: chip.slug })) } : {}),
    ...(await extras()),
  };
}

/** A file with no pages to read — a .docx: its title, filename, size and tags; its bytes through `download`. */
async function readPlainFile(file: ResolvedFile): Promise<ToolResult> {
  const chips = await tagsForTarget({ kind: "file", id: file.id });
  return {
    kind: "file",
    id: file.id,
    url: `/files/${file.slug}`,
    title: file.title,
    filename: file.filename,
    contentType: file.contentType,
    size: file.byteSize,
    visibility: file.visibility,
    ...(chips.length > 0 ? { tags: chips.map((chip) => ({ name: chip.name, slug: chip.slug })) } : {}),
  };
}

function surroundings(text: string, start: number, end: number) {
  return {
    before: `${start > SURROUNDINGS ? "…" : ""}${text.slice(Math.max(0, start - SURROUNDINGS), start)}`,
    text: text.slice(start, end),
    after: `${text.slice(end, end + SURROUNDINGS)}${end + SURROUNDINGS < text.length ? "…" : ""}`,
  };
}

/**
 * Every occurrence of a quote in the PDF (or on the pages named), by its
 * skeleton (§7): letters and digits in order, accents and case folded, a word
 * boundary at each end — a PDF's extracted text splits and joins words, which
 * no folding of typography undoes. One retry as Markdown.
 */
async function aroundQuote(file: ResolvedFile, labels: string[] | null, args: ReadArgs): Promise<ToolResult> {
  const pageCount = file.pageCount!;
  const indexes =
    args.page !== undefined
      ? [args.page - 1]
      : args.pages !== undefined
        ? pageRange(args.pages, pageCount)
        : args.label !== undefined
          ? pagesLabelled(labels, args.label)
          : allPages(pageCount);
  const texts = await pageTexts(file.versionId, indexes);
  const passage = (quote: string, prefix?: string, suffix?: string): PassageText => onePassage(quote, { prefix, suffix });
  const find = (p: PassageText) =>
    indexes.flatMap((index) => {
      const text = texts.get(index) ?? "";
      return resolveAll(text, p, skeletonOf(text)).map((range) => ({ index, range }));
    });
  let found = find(passage(args.around!, args.prefix, args.suffix));
  let viaMarkdown = false;
  if (found.length === 0) {
    const reread = markdownToText(args.around!);
    if (skeletonOf(reread).text !== skeletonOf(args.around!).text) {
      found = find(passage(reread, args.prefix && markdownToText(args.prefix), args.suffix && markdownToText(args.suffix)));
      viaMarkdown = found.length > 0;
    }
  }
  if (found.length === 0) {
    const misses: { score: number; miss: Record<string, unknown> }[] = [];
    for (const index of indexes) {
      const text = texts.get(index) ?? "";
      for (const window of overlapWindows(text, args.around!, 3)) {
        misses.push({
          score: window.score,
          miss: { page: index + 1, ...(labels ? { label: labels[index] } : {}), text: text.slice(window.start, window.end) },
        });
      }
    }
    throw new ApiError("no_match", "That quote isn't in this PDF as written.", {
      nearMisses: misses
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ miss }) => miss),
    });
  }
  const limit = args.occurrences ?? 5;
  return {
    kind: "pdf-around",
    url: file.url,
    total: found.length,
    ...(viaMarkdown ? { matchedAs: "markdown" } : {}),
    occurrences: found.slice(0, limit).map(({ index, range }) => ({
      page: index + 1,
      ...(labels ? { label: labels[index] } : {}),
      ...surroundings(texts.get(index) ?? "", range.start, range.end),
    })),
  };
}

/**
 * A fragment link read as its passage (§8): each `text` resolved as the
 * viewer resolves it (`resolvePassage`, on the first of the sheets its page
 * names that holds it), with about 300 characters either side, its page and
 * its label — rather than the page, since following a summary's citations
 * page by page would read mostly other text. A passage that isn't there
 * answers `no_match` with what the fragment-link check reports: where its
 * skeleton stops matching, what the page has there, and the page it is on
 * instead when it occurs exactly once elsewhere.
 */
async function fragmentPassages(
  file: ResolvedFile,
  labels: string[] | null,
  ownLabels: string[] | null,
  fragment: string,
): Promise<ToolResult> {
  const passages = parseFragmentPassages(`#${fragment}`);
  if (passages.length === 0) throw invalid("That fragment's text= parameters don't parse as a fragment link.");
  const pageCount = file.pageCount!;
  const sheetsOf = passages.map((passage) => sheetsNamed(passage.page, ownLabels, pageCount));
  const texts = await pageTexts(file.versionId, [...new Set(sheetsOf.flat())]);
  const out: Record<string, unknown>[] = [];
  for (const [n, passage] of passages.entries()) {
    let found: { index: number; text: string; range: { start: number; end: number } } | null = null;
    for (const index of sheetsOf[n]) {
      const text = texts.get(index);
      const range = text !== undefined ? resolvePassage(text, passage) : null;
      if (text !== undefined && range) {
        found = { index, text, range };
        break;
      }
    }
    if (!found) {
      // The check's own finding, over every page, for the answer.
      const all = await pageTexts(file.versionId, allPages(pageCount));
      const pages: FilePages = {
        fileId: file.id,
        slug: file.slug,
        pageCount,
        textVersion: await currentTextVersion(),
        ownLabels,
        pages: new Map([...all].map(([i, t]) => [i, { text: t, skeleton: skeletonOf(t) }])),
      };
      const finding = checkPassage(pages, passage);
      throw new ApiError("no_match", `A passage of that fragment link isn't on ${pageText(passage.page)}.`, {
        passage: passageWords(passage),
        ...(finding.kind === "no-match"
          ? {
              matchedUpTo: finding.matchedUpTo,
              pageHasThere: finding.pageHasThere,
              ...(finding.foundOnPage !== null ? { foundOnPage: finding.foundOnPage } : {}),
            }
          : finding.kind === "page-out-of-range"
            ? { pageCount }
            : finding.kind === "no-such-label"
              ? { noSuchLabel: true, ...(finding.foundOnPage !== null ? { foundOnPage: finding.foundOnPage } : {}) }
              : {}),
      });
    }
    out.push({ page: found.index + 1, ...(labels ? { label: labels[found.index] } : {}), ...surroundings(found.text, found.range.start, found.range.end) });
  }
  return { kind: "pdf-passages", url: file.url, passages: out };
}
