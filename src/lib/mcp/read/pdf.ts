import { prisma } from "@/lib/prisma";
import { currentTextVersion } from "@/lib/pdf-extract";
import { storedPageText } from "@/lib/pdf-page-text";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { labelRanges, pageNameForSheet, pagesLabelled, sheetsLabelled, sheetsNamed, usablePageLabels } from "@/lib/pdf-page-labels";
import { formatPageName, pageFromHash, type PageName, type PageStamp } from "@/lib/pdf-open-params";
import { pageStampFor, pdfPath } from "@/lib/file-version";
import { carriedElsewhere, readPage, type PageReading } from "@/lib/pdf-link-reading";
import { FragmentChecker } from "@/lib/pdf-fragment-check";
import { onePassage, parseFragmentPassages, passageWords, resolveAll, resolvePassage, skeletonOf, type PassageText } from "@/lib/pdf-fragment";
import { checkPassage, checkPassageAt, passageElsewhere, type FilePages } from "@/lib/pdf-fragment-findings";
import { overlapWindows } from "@/lib/comment-quote-match";
import { markdownToText } from "@/lib/markdown-import";
import { tagsForTarget } from "@/lib/tag-data";
import type { StoredOutlineEntry } from "@/lib/pdf-extract";
import { ApiError, ERROR_LIST_CAP, invalid } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "../tool";
import { dayOf } from "../shape";
import { readableFileBySlug, type ResolvedFile } from "../resolve";
import { fragmentParams } from "../url";
import { readBoundFor, type ReadArgs } from "./args";

// docs/MCP.md §8 — reading a PDF: the file itself (title, page count, labels
// as ranges, outline, tags), a page or a run of pages, every page carrying a
// label, an outline entry's pages, every occurrence of a quote with its
// surroundings, and a fragment link read as its passage.
//
// **Numbering.** A tool's `sheet` is the 1-based sheet number, as `#sheet=`
// and search's hits use it, and its `page` is the printed page, the sheet's
// label; responses carry the page beside the sheet wherever the PDF has
// usable labels. Labels are a lookup, never a coordinate.
//
// **Versions** (docs/PDF.md §13). The tool's own `sheet`, `sheets` and `page`
// are of the version read: the latest, or the one a version's own address
// names. **A fragment in the URL is read by the viewer's rules**
// (src/lib/pdf-link-reading.ts): its `v=` names the version whose sheets it
// counts, and without one it names the file's first, or on a version's own
// address that version. The two can be the same number and different sheets,
// so once a file has a second version every sheet answered carries `link`,
// its stamped form, which is what to write. A fragment that names another
// version is carried to the version read, through the page maps between the
// two, and the answer's `note` says how it was read where that changed the
// sheet. One that can't be carried is answered on the version it names, and
// the `note` says so.

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

/** The outline as a read shows it: entries to a depth, each with its sheet, page and how many sheets it spans. */
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
            sheet: pages.from + 1,
            ...(labels ? { page: labels[pages.from] } : {}),
            sheets: pages.to - pages.from + 1,
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
        sheet: entries[index].pageIndex === null ? null : entries[index].pageIndex! + 1,
      })),
      total: found.length,
    });
  }
  return found[0];
}

/**
 * Sheets as a read returns them, fitted to the token's bound: each with its
 * number, its printed page and its text, and the next sheet to ask for when
 * they don't all fit.
 */
async function pagesResult(file: ResolvedFile, labels: string[] | null, ownLabels: string[] | null, indexes: number[], maxChars: number): Promise<ToolResult> {
  const texts = await pageTexts(file.versionId, indexes);
  const pages: Record<string, unknown>[] = [];
  let size = 0;
  let next: number | null = null;
  const stamp = stampOf(file);
  for (const index of indexes) {
    const entry = {
      sheet: index + 1,
      ...(labels ? { page: labels[index] } : {}),
      // The sheet's stamped form, once the file has a second version: a link without `v=` would name the first.
      ...(stamp !== "sole" ? { link: `${pdfPath(file.slug)}#${formatPageName({ ...pageNameForSheet(ownLabels, file.pageCount ?? 0, index), stamp })}` } : {}),
      text: texts.get(index) ?? "",
    };
    const cost = JSON.stringify(entry).length;
    if (pages.length > 0 && size + cost > maxChars - 1000) {
      next = index + 1;
      break;
    }
    pages.push(entry);
    size += cost;
  }
  return { kind: "pdf-pages", url: file.url, sheets: pages, ...(next !== null ? { next } : {}) };
}

/** The stamp a link to the version read carries (`pageStampFor`). */
function stampOf(file: ResolvedFile): PageStamp {
  return pageStampFor(file.versionNumber, file.versions.length);
}

/** `1-based N` or `N-M` sheets into 0-based page indexes, inside the file. */
function pageRange(spec: string, pageCount: number): number[] {
  const [a, b] = spec.split("-").map(Number);
  const from = a;
  const to = b ?? a;
  if (from < 1 || to < from || from > pageCount) {
    throw invalid(`This PDF has ${pageCount} sheets; ${spec} isn't a range of them.`);
  }
  return Array.from({ length: Math.min(to, pageCount) - from + 1 }, (_, k) => from - 1 + k);
}

/** What the fragment names: a page (`#sheet=N`, or `#p=<label>` by printed page) and whether it has a fragment link's `text` parameters. */
function viewerFragment(fragment: string): { page: PageName | null; hasText: boolean } {
  const hasText = fragmentParams(fragment).some(([key]) => key === "text");
  return { page: pageFromHash(`#${fragment}`), hasText };
}

/** A page as an answer names it. */
function pageText(page: PageName): string {
  return "sheet" in page ? `sheet ${page.sheet}` : `page ${page.label}`;
}

export async function readPdf(ctx: McpContext, file: ResolvedFile, args: ReadArgs, fragment: string, extras: () => Promise<ToolResult>): Promise<ToolResult> {
  if (file.pageCount === null) return readPlainFile(file);
  for (const docOnly of ["since", "section", "from", "to", "whole"] as const) {
    if (args[docOnly] !== undefined) throw invalid(`${docOnly} is for a doc; a PDF reads by sheet, sheets, page or outline entry.`);
  }
  const metadata = await pdfMetadata(file.versionId);
  const labels = metadata ? usablePageLabels(metadata.pageLabels, file.pageCount) : null;
  // The labels the file itself gives, which a `p=` is matched against, never `labels`' filled-in copy.
  const ownLabels = metadata?.pageLabels ?? null;
  const pageCount = file.pageCount;
  const maxChars = readBoundFor(ctx.token.client);
  const { page: fragmentPage, hasText } = viewerFragment(fragment);

  // The fragment's page is read as the viewer reads a link (docs/PDF.md §13,
  // "Links into the file"), by the version it names.
  const address = { shown: file.versionNumber, own: file.versionAddressed };
  // Only where the fragment decides what is read: the tool's own `sheet`, `sheets`, `page`, `entry` and `around` are of the version read.
  const fragmentRead = hasText || [args.sheet, args.sheets, args.page, args.entry, args.around].every((arg) => arg === undefined);
  const reading: PageReading | null = fragmentPage && fragmentRead ? readPage(fragmentPage, address, file.versions) : null;
  let note: string | undefined;
  // A carried link whose sheet has no counterpart here is carried only by its
  // words, where they occur exactly once in the version read. One without
  // words, or whose words aren't found so, is not carried.
  const lost =
    reading?.kind === "carried" && reading.sheets.length === 0 && reading.state !== "abandoned"
      ? !hasText || !(await firstPassageFoundOnce(file, fragment))
      : false;
  if (reading?.kind === "elsewhere" || lost) {
    // It can't be carried, so the link opens the version it names.
    const named = await readableFileBySlug(ctx.actor, file.id, reading!.version);
    const said = fragmentPage?.v === undefined ? "a link without v= names the file's first version" : `its v= names version ${reading!.version}`;
    const why = lost ? `its ${pageText(fragmentPage!)} has no counterpart on version ${file.versionNumber}` : `no page map joins it to version ${file.versionNumber}`;
    return {
      ...(await readPdf(ctx, named, args, fragment, extras)),
      note: `Read on version ${reading!.version}, at ${named.url}: ${said}, and ${why}.`,
    };
  }
  if (reading?.kind === "carried" && fragmentPage) {
    const said = fragmentPage.v === undefined ? "a link without v= names the file's first version" : `its v= names version ${reading.version}`;
    if (reading.sheets.length === 0) {
      // Only an abandoned version's link, or one whose words were found, gets here.
      if (!hasText) {
        throw new ApiError("not_found", `Version ${reading.version} of this file was abandoned, and its ${pageText(fragmentPage)} has no counterpart on version ${file.versionNumber}.`);
      }
      note = `Read as version ${reading.version}'s: ${said}. Its ${pageText(fragmentPage)} has no counterpart on version ${file.versionNumber}, so each passage was looked for by its words alone.`;
    } else {
      const landed = reading.sheets[0];
      if (carriedElsewhere(fragmentPage, landed, ownLabels, pageCount)) {
        note = `Read as version ${reading.version}'s: ${said}, and its ${pageText(fragmentPage)} is sheet ${landed + 1} of version ${file.versionNumber}.`;
      }
      if (!hasText) {
        const result = await pagesResult(file, labels, ownLabels, [landed], maxChars);
        return note ? { ...result, note } : result;
      }
    }
  } else if (reading && reading.kind !== "here") {
    const gone =
      reading.kind === "abandoned"
        ? `Version ${reading.version} of this file was abandoned, and its sheets were never matched to another version's.`
        : `This file has no version ${reading.version}.`;
    if (!hasText && reading.kind === "abandoned") {
      throw new ApiError("not_found", `${gone} Nothing says which sheet of version ${file.versionNumber} that link names.`);
    }
    note = hasText
      ? `${gone} Each passage was looked for by its words alone, in version ${file.versionNumber}.`
      : `${gone} The sheet is read as written, on version ${file.versionNumber}.`;
  }
  const noted = (result: ToolResult): ToolResult => (note ? { ...result, note } : result);

  if (hasText) return noted(await fragmentPassages(file, labels, ownLabels, fragment));
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
    return pagesResult(file, labels, ownLabels, allPages(pageCount).slice(span.from, span.to + 1), maxChars);
  }

  const asked = [args.sheet !== undefined, args.sheets !== undefined, args.page !== undefined].filter(Boolean).length;
  if (asked > 1) throw invalid("Name sheets one way per read: sheet, sheets or page.");
  if (args.page !== undefined) {
    const indexes = pagesLabelled(labels, args.page).filter((index) => index < pageCount);
    if (indexes.length === 0) throw new ApiError("not_found", `No sheet of this PDF has the printed page "${args.page}".`);
    return pagesResult(file, labels, ownLabels, indexes, maxChars);
  }
  if (args.sheets !== undefined) return pagesResult(file, labels, ownLabels, pageRange(args.sheets, pageCount), maxChars);
  // A page link opens at the first sheet carrying its label, as the viewer does.
  if (args.sheet === undefined && fragmentPage !== null && "label" in fragmentPage) {
    const sheets = sheetsLabelled(ownLabels, pageCount, fragmentPage.label);
    if (sheets.length === 0) throw new ApiError("not_found", `No sheet of this PDF has the printed page "${fragmentPage.label}".`);
    return noted(await pagesResult(file, labels, ownLabels, [sheets[0]], maxChars));
  }
  const sheet = args.sheet ?? (fragmentPage && "sheet" in fragmentPage ? fragmentPage.sheet : null);
  if (sheet !== null && sheet !== undefined) {
    if (sheet > pageCount) throw invalid(`This PDF has ${pageCount} sheets.`);
    return args.sheet === undefined ? noted(await pagesResult(file, labels, ownLabels, [sheet - 1], maxChars)) : pagesResult(file, labels, ownLabels, [sheet - 1], maxChars);
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
    sheets: pageCount,
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
    args.sheet !== undefined
      ? [args.sheet - 1]
      : args.sheets !== undefined
        ? pageRange(args.sheets, pageCount)
        : args.page !== undefined
          ? pagesLabelled(labels, args.page)
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
          miss: { sheet: index + 1, ...(labels ? { page: labels[index] } : {}), text: text.slice(window.start, window.end) },
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
      sheet: index + 1,
      ...(labels ? { page: labels[index] } : {}),
      ...surroundings(texts.get(index) ?? "", range.start, range.end),
    })),
  };
}

/** Whether the first passage of a fragment is on exactly one sheet of the version read, once: what carries a link whose sheet has no counterpart. */
async function firstPassageFoundOnce(file: ResolvedFile, fragment: string): Promise<boolean> {
  const first = parseFragmentPassages(`#${fragment}`)[0];
  if (!first) return false;
  return (await new FragmentChecker().sheetHolding(file.id, file.versionId, first, [])) !== null;
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
 *
 * Each passage is read by the version it names. One that names the version
 * read is found on its sheets. One the page maps carry to the version read
 * is found on the sheets it lands on, and marked `carriedFrom`. One that
 * names an abandoned version or a version the file never had, or whose sheet
 * has no counterpart, is looked for by its words alone: it is answered where
 * exactly one sheet of the version read holds it, once, marked `foundBy`.
 * One that names another version, which no page map joins to the first
 * passage's, is refused: the link is read on one version.
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
  const address = { shown: file.versionNumber, own: file.versionAddressed };
  const readings = passages.map((passage) => readPage(passage.page, address, file.versions));
  const sheetsOf = passages.map((passage, n) => {
    const reading = readings[n];
    return reading.kind === "here" ? sheetsNamed(passage.page, ownLabels, pageCount) : reading.kind === "carried" ? reading.sheets : [];
  });
  const texts = await pageTexts(file.versionId, [...new Set(sheetsOf.flat())]);
  // Every page of the version read, for a miss and for a passage looked for by its words alone.
  let whole: FilePages | null = null;
  const wholeVersion = async (): Promise<FilePages> => {
    if (whole) return whole;
    const all = await pageTexts(file.versionId, allPages(pageCount));
    whole = {
      fileId: file.id,
      slug: file.slug,
      versionNumber: file.versionNumber,
      stamp: stampOf(file),
      pageCount,
      textVersion: await currentTextVersion(),
      ownLabels,
      pages: new Map([...all].map(([i, t]) => [i, { text: t, skeleton: skeletonOf(t) }])),
    };
    return whole;
  };
  const out: Record<string, unknown>[] = [];
  for (const [n, passage] of passages.entries()) {
    const reading = readings[n];
    if (reading.kind === "elsewhere") {
      throw invalid(`That link's passages name different versions (${file.versionNumber} and ${reading.version}); read each on its own version's address.`);
    }
    let found: { index: number; text: string; range: { start: number; end: number } } | null = null;
    if (reading.kind !== "here" && !(reading.kind === "carried" && reading.sheets.length > 0)) {
      const pages = await wholeVersion();
      const sheet = passageElsewhere(pages, passage, []);
      const held = sheet !== null ? pages.pages.get(sheet - 1) : undefined;
      const range = held ? resolvePassage(held.text, passage, held.skeleton) : null;
      if (sheet === null || !held || !range) {
        const why = reading.kind === "carried" ? `whose ${pageText(passage.page)} has no counterpart here` : "which can't be read";
        throw new ApiError("no_match", `A passage of that link names version ${reading.version}, ${why}, and its words aren't on exactly one sheet of version ${file.versionNumber}.`, {
          passage: passageWords(passage),
        });
      }
      out.push({ sheet, ...(labels ? { page: labels[sheet - 1] } : {}), foundBy: "its words alone", ...surroundings(held.text, range.start, range.end) });
      continue;
    }
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
      const finding = reading.kind === "carried" ? checkPassageAt(await wholeVersion(), passage, sheetsOf[n]) : checkPassage(await wholeVersion(), passage);
      const where =
        reading.kind === "carried"
          ? `sheet ${sheetsOf[n][0] + 1} of version ${file.versionNumber}, where version ${reading.version}'s ${pageText(passage.page)} is now`
          : pageText(passage.page);
      throw new ApiError("no_match", `A passage of that fragment link isn't on ${where}.`, {
        passage: passageWords(passage),
        ...(finding.kind === "no-match"
          ? {
              matchedUpTo: finding.matchedUpTo,
              pageHasThere: finding.pageHasThere,
              ...(finding.foundOnPage !== null ? { foundOnSheet: finding.foundOnPage } : {}),
            }
          : finding.kind === "page-out-of-range"
            ? { sheetCount: pageCount }
            : finding.kind === "no-such-label"
              ? { noSuchPage: true, ...(finding.foundOnPage !== null ? { foundOnSheet: finding.foundOnPage } : {}) }
              : {}),
      });
    }
    out.push({
      sheet: found.index + 1,
      ...(labels ? { page: labels[found.index] } : {}),
      ...(reading.kind === "carried" ? { carriedFrom: { version: reading.version, ...("sheet" in passage.page ? { sheet: passage.page.sheet } : { page: passage.page.label }) } } : {}),
      ...surroundings(found.text, found.range.start, found.range.end),
    });
  }
  return { kind: "pdf-passages", url: file.url, passages: out };
}
