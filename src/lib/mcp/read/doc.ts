import type { Node as PMNode } from "@tiptap/pm/model";
import { prisma } from "@/lib/prisma";
import { docTitleOrFallback } from "@/lib/doc-title";
import { tagsForTarget } from "@/lib/tag-data";
import { displayNameOf } from "@/lib/display-name";
import { docContentToMarkdown, markdownToText } from "@/lib/markdown-import";
import { flattenForMatch } from "@/lib/comment-quote-match";
import { contextOf, resolveQuote } from "@/lib/quote-resolve";
import { alignBlocks, diffRuns, renderWordDiff } from "@/lib/block-align";
import {
  blocksOfRange,
  docOutline,
  docText,
  findHeading,
  headingAbove,
  sectionOf,
  type BlockSpan,
  type DocBlock,
} from "@/lib/doc-text";
import { isDocVersion, loadDocState, loadDocStateAt, type DocState } from "@/lib/doc-state";
import { ApiError, ERROR_LIST_CAP, invalid } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "../tool";
import { bylineOf, dayOf, sizeOf } from "../shape";
import type { ResolvedDoc } from "../resolve";
import { DEFAULT_READ_CHARS, MAX_READ_CHARS, type ReadArgs } from "./args";

// docs/MCP.md §6 — reading a doc: whole, as its outline, a section, a run of
// blocks, every occurrence of a quote with the blocks around it, or what has
// changed since a version. A read of the whole doc or its outline carries the
// metadata; a ranged read carries `version` and its range alone, since the
// rest came with the first read.

type Format = "markdown" | "text";

/** One block in the format asked for. */
function renderBlock(block: DocBlock, format: Format): string {
  if (format === "text") return block.text;
  return docContentToMarkdown({ type: "doc", content: [block.node.toJSON()] }).trim();
}

function render(blocks: readonly DocBlock[], format: Format): string {
  return format === "text" ? docText(blocks) : blocks.map((block) => renderBlock(block, format)).join("\n\n");
}

/**
 * As many of `blocks` as fit in `budget` characters of serialized result,
 * always at least one, and the number of the first block left out.
 */
function fitBlocks(blocks: readonly DocBlock[], format: Format, budget: number): { body: string; next: number | null } {
  const parts: string[] = [];
  let size = 0;
  for (const block of blocks) {
    const part = renderBlock(block, format);
    // JSON-escaped, as the result will be measured.
    const cost = JSON.stringify(part).length - 2 + (parts.length > 0 ? 2 : 0);
    if (parts.length > 0 && size + cost > budget) {
      return { body: parts.join(format === "text" ? "\n" : "\n\n"), next: block.number };
    }
    parts.push(part);
    size += cost;
  }
  return { body: parts.join(format === "text" ? "\n" : "\n\n"), next: null };
}

/** The body's key: `markdown` or `text`, so the model sees which it has. */
function bodyKey(format: Format): "markdown" | "text" {
  return format;
}

function versionOf(state: { version: bigint | null }): string | null {
  return state.version?.toString() ?? null;
}

/** What a whole read and an outline read both carry about the doc. */
async function docMeta(doc: ResolvedDoc, state: DocState): Promise<ToolResult> {
  const [row, chips] = await Promise.all([
    prisma.doc.findUnique({
      where: { id: doc.id },
      select: {
        updatedAt: true,
        proseJsonLength: true,
        authors: { orderBy: { bylineOrder: "asc" }, select: { user: { select: { name: true } } } },
      },
    }),
    tagsForTarget({ kind: "doc", id: doc.id }),
  ]);
  return {
    kind: "doc",
    id: doc.id,
    url: `/doc/${doc.slug}`,
    title: docTitleOrFallback(doc.title),
    byline: bylineOf(row?.authors.map((a) => a.user) ?? []),
    visibility: doc.visibility,
    ...(doc.record ? { record: true } : {}),
    updated: row ? dayOf(row.updatedAt) : null,
    version: versionOf(state),
    blocks: state.blocks.length,
    chars: row?.proseJsonLength ?? 0,
    ...(chips.length > 0 ? { tags: chips.map((chip) => ({ name: chip.name, slug: chip.slug })) } : {}),
  };
}

function outlineOf(blocks: readonly DocBlock[], opts: { depth?: number; within?: BlockSpan }) {
  const { entries, deeper } = docOutline(blocks, opts);
  return { entries, ...(deeper > 0 ? { deeper } : {}) };
}

/** The blocks of a section named by its heading. */
function sectionBlocks(blocks: readonly DocBlock[], section: string | number): BlockSpan {
  const found = findHeading(blocks, section, ERROR_LIST_CAP);
  switch (found.kind) {
    case "found":
      return sectionOf(blocks, found.block.number);
    case "ambiguous":
      throw new ApiError("ambiguous", `More than one section is headed "${section}"; name it by its block number.`, {
        blocks: found.blocks,
        total: found.total,
      });
    case "not-heading":
      throw invalid(`Block ${section} isn't a heading; read it with from and to instead.`);
    case "none":
      throw new ApiError("not_found", `No heading ${typeof section === "number" ? `at block ${section}` : `"${section}"`} in this doc.`);
  }
}

export type DocReadOptions = { includeBody: (span: BlockSpan | null) => Promise<ToolResult> };

/**
 * `read` of a doc. `extras` adds what `include` asked for, scoped to the
 * blocks a ranged read returns (threads whose passage lies in the range).
 */
export async function readDoc(
  ctx: McpContext,
  doc: ResolvedDoc,
  args: ReadArgs,
  extras: (state: DocState, span: BlockSpan | null) => Promise<ToolResult>,
): Promise<ToolResult> {
  const format: Format = args.format ?? "markdown";
  const ranged = args.section !== undefined || args.from !== undefined || args.to !== undefined;
  const modes = [args.since !== undefined, args.around !== undefined, ranged].filter(Boolean).length;
  if (modes > 1) throw invalid("Ask for one of since, around, or a range (section, from/to) per read.");
  for (const pdfOnly of ["page", "pages", "label", "entry"] as const) {
    if (args[pdfOnly] !== undefined) throw invalid(`${pdfOnly} is for a PDF; a doc reads by section or by blocks.`);
  }

  const state = await loadDocState(doc.id);
  const url = `/doc/${doc.slug}`;

  if (args.since !== undefined) return changesSince(doc, state, BigInt(args.since));
  if (args.around !== undefined) {
    return { ...(await aroundQuote(state, args, format, url)), ...(await extras(state, null)) };
  }

  if (ranged) {
    const span =
      args.section !== undefined
        ? sectionBlocks(state.blocks, args.section)
        : { from: args.from ?? 1, to: Math.min(args.to ?? state.blocks.length, state.blocks.length) };
    if (span.from > state.blocks.length) {
      throw invalid(`This doc has ${state.blocks.length} blocks; block ${span.from} is past its end.`);
    }
    if (span.to < span.from) throw invalid("to comes before from.");
    if (args.outline) {
      return { kind: "doc-outline", url, version: versionOf(state), from: span.from, to: span.to, outline: outlineOf(state.blocks, { depth: args.depth, within: span }) };
    }
    const fitted = fitBlocks(state.blocks.slice(span.from - 1, span.to), format, MAX_READ_CHARS - 1000);
    const lastIncluded = fitted.next === null ? span.to : fitted.next - 1;
    return {
      kind: "doc-blocks",
      url,
      version: versionOf(state),
      from: span.from,
      to: lastIncluded,
      ...(fitted.next !== null ? { next: fitted.next } : {}),
      [bodyKey(format)]: fitted.body,
      ...(await extras(state, { from: span.from, to: lastIncluded })),
    };
  }

  const meta = await docMeta(doc, state);
  const more = await extras(state, null);
  if (!args.outline) {
    const whole = { ...meta, [bodyKey(format)]: render(state.blocks, format), ...more };
    const bound = args.whole ? MAX_READ_CHARS : DEFAULT_READ_CHARS;
    if (sizeOf(whole) <= bound) return whole;
  }
  const automatic = !args.outline;
  return {
    ...meta,
    outline: outlineOf(state.blocks, { depth: args.depth ?? (automatic ? 1 : undefined) }),
    ...(automatic
      ? {
          note: args.whole
            ? `Longer than ${MAX_READ_CHARS} characters: read it by section or by blocks.`
            : `Longer than ${DEFAULT_READ_CHARS} characters: read the sections you need, or pass whole:true for up to ${MAX_READ_CHARS}.`,
        }
      : {}),
    ...more,
  };
}

/**
 * Every occurrence of a quote, each with the blocks it lies in and `context`
 * blocks either side — the matcher run as a read (§7), so it answers whether
 * the quote is really there as well as where. Occurrences are returned rather
 * than refused, since nothing is being anchored.
 */
async function aroundQuote(state: DocState, args: ReadArgs, format: Format, url: string): Promise<ToolResult> {
  const target = flattenForMatch(state.node);
  const resolution = resolveQuote(target, { quote: args.around, prefix: args.prefix, suffix: args.suffix }, markdownToText);
  if (resolution.kind === "none") {
    throw new ApiError("no_match", "That quote isn't in this doc as written.", {
      nearMisses: resolution.nearMisses.map((miss) => ({
        text: miss.quotedText,
        context: contextOf(target, miss),
        ...locate(state.blocks, miss.from, miss.to),
      })),
    });
  }
  const context = args.context ?? 1;
  const limit = args.occurrences ?? 5;
  const occurrences = resolution.matches.slice(0, limit).map((match) => {
    const at = blocksOfRange(state.blocks, match.from, match.to) ?? { from: 1, to: 1 };
    const from = Math.max(1, at.from - context);
    const to = Math.min(state.blocks.length, at.to + context);
    const heading = headingAbove(state.blocks, at.from);
    return {
      in: at.from === at.to ? String(at.from) : `${at.from}-${at.to}`,
      from,
      to,
      ...(heading && heading.number !== at.from ? { heading: heading.heading!.text } : {}),
      [bodyKey(format)]: render(state.blocks.slice(from - 1, to), format),
    };
  });
  return {
    kind: "doc-around",
    url,
    version: versionOf(state),
    total: resolution.matches.length,
    ...(resolution.viaMarkdown ? { matchedAs: "markdown" } : {}),
    occurrences,
  };
}

/** Where a range is: its blocks and the heading over them. */
function locate(blocks: readonly DocBlock[], from: number, to: number): { blocks?: string; heading?: string } {
  const at = blocksOfRange(blocks, from, to);
  if (!at) return {};
  const heading = headingAbove(blocks, at.from);
  return {
    blocks: at.from === at.to ? String(at.from) : `${at.from}-${at.to}`,
    ...(heading ? { heading: heading.heading!.text } : {}),
  };
}

/**
 * Per character of `blockText(node)`, the `authorHighlight` it carries, or
 * null — a line break between textblocks, a hard break, and unmarked text
 * (an import's) carry none.
 */
function charAuthors(node: PMNode): (string | null)[] {
  if (node.isTextblock) {
    const out: (string | null)[] = [];
    node.forEach((child) => {
      if (child.isText) {
        const mark = child.marks.find((m) => m.type.name === "authorHighlight");
        const id = (mark?.attrs.authorId as string | undefined) || null;
        for (let i = 0; i < (child.text ?? "").length; i++) out.push(id);
      } else if (child.type.name === "hardBreak") {
        out.push(null);
      }
    });
    return out;
  }
  if (node.isLeaf) return [];
  // blockText's container rule, mirrored: each child that contributes a line,
  // with a line break between them.
  const lines: (string | null)[][] = [];
  node.forEach((child) => {
    const line = charAuthors(child);
    if (child.isTextblock || line.length > 0) lines.push(line);
  });
  return lines.flatMap((line, index) => (index > 0 ? [null, ...line] : line));
}

/**
 * What changed since `since`: the doc rebuilt once at that version, its blocks
 * aligned with the doc as read, and a word diff within each pair (§6). Each
 * block names who wrote what it gained, from the `authorHighlight` marks; a
 * deletion carries no mark, so who removed something isn't said.
 */
async function changesSince(doc: ResolvedDoc, state: DocState, since: bigint): Promise<ToolResult> {
  if (!(await isDocVersion(doc.id, since))) {
    throw invalid("That version isn't in this doc's history; pass a version a read of this doc returned.");
  }
  const before = await loadDocStateAt(doc.id, since);
  const pairs = alignBlocks(
    before.blocks.map((b) => b.text),
    state.blocks.map((b) => b.text),
  );

  const authorIds = new Set<string>();
  type Pending = { result: Record<string, unknown>; runs: (string | null)[][] };
  const pending: Pending[] = [];
  for (const pair of pairs) {
    const oldBlock = pair.old !== null ? before.blocks[pair.old] : null;
    const newBlock = pair.new !== null ? state.blocks[pair.new] : null;
    if (oldBlock && newBlock && oldBlock.text === newBlock.text) continue;
    const heading = newBlock ? headingAbove(state.blocks, newBlock.number) : headingAbove(before.blocks, oldBlock!.number);
    const headingText = heading && heading.number !== (newBlock ?? oldBlock)!.number ? heading.heading!.text : undefined;
    if (newBlock && !oldBlock) {
      const authors = charAuthors(newBlock.node);
      pending.push({ result: { block: newBlock.number, ...(headingText ? { heading: headingText } : {}), added: newBlock.text }, runs: [authors] });
      authors.forEach((id) => id && authorIds.add(id));
      continue;
    }
    if (oldBlock && !newBlock) {
      pending.push({ result: { ...(headingText ? { heading: headingText } : {}), deleted: oldBlock.text }, runs: [] });
      continue;
    }
    const runs = diffRuns(oldBlock!.text, newBlock!.text);
    const authors = charAuthors(newBlock!.node);
    const insertAuthors = runs
      .filter((run) => run.type === "insert")
      .map((run) => authors.slice(run.start, run.end));
    insertAuthors.flat().forEach((id) => id && authorIds.add(id));
    pending.push({
      result: { block: newBlock!.number, ...(headingText ? { heading: headingText } : {}), diff: renderWordDiff(runs) },
      runs: insertAuthors,
    });
  }

  const users = authorIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...authorIds] } }, select: { id: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, displayNameOf(u)]));
  const writerOf = (ids: (string | null)[]): string | null => {
    const counts = new Map<string, number>();
    for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    let best: string | null = null;
    for (const [id, count] of counts) if (best === null || count > counts.get(best)!) best = id;
    return best ? (names.get(best) ?? "Anonymous") : null;
  };

  const changes: Record<string, unknown>[] = [];
  let size = 0;
  let more = 0;
  for (const { result, runs } of pending) {
    const writers = runs.map(writerOf);
    if (writers.length > 0 && writers.some((w) => w !== null)) {
      result.by = writers.every((w) => w === writers[0]) ? writers[0] : writers;
    }
    const cost = sizeOf(result);
    if (size + cost > DEFAULT_READ_CHARS) {
      more++;
      continue;
    }
    size += cost;
    changes.push(result);
  }
  return {
    kind: "doc-changes",
    url: `/doc/${doc.slug}`,
    since: since.toString(),
    version: versionOf(state),
    changes,
    ...(more > 0 ? { more, note: `${more} more changed blocks than fit; read the blocks themselves.` } : {}),
  };
}
