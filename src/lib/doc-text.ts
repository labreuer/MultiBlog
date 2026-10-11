import type { Node as PMNode } from "@tiptap/pm/model";
import { normalizeForMatch } from "./comment-quote-match";

// docs/MCP.md §6 — a doc read as a machine client reads it: its top-level
// blocks, numbered; its text form; its outline with each section's size; and
// a section found by its heading.
//
// Pure and browser-safe, over a ProseMirror node, so the reads are unit tests
// (doc-text.test.ts). The Markdown form is markdown-import.ts's
// `docContentToMarkdown`, which needs the extension list this file doesn't.

/** One top-level block, as the outline numbers it. */
export type DocBlock = {
  /** 1-based: the first block of the doc is block 1. */
  number: number;
  node: PMNode;
  /** The block's span in the doc, [from, to) in ProseMirror positions. */
  from: number;
  to: number;
  /** The block's text form (`blockText`). */
  text: string;
  heading: { level: number; text: string } | null;
};

/**
 * A block's characters and none of Markdown's syntax: a line break between
 * textblocks, so each table cell and each list item's paragraph is a line of
 * its own, and a hard break is a line break too. It is what the quote matcher
 * flattens (comment-quote-match.ts), where every one of those boundaries
 * becomes a space — so a quote copied out of a text read matches as written.
 */
export function blockText(node: PMNode): string {
  if (node.isTextblock) return inlineText(node);
  if (node.isLeaf) return node.isText ? (node.text ?? "") : "";
  const lines: string[] = [];
  node.forEach((child) => {
    const text = blockText(child);
    if (child.isTextblock || text !== "") lines.push(text);
  });
  return lines.join("\n");
}

function inlineText(node: PMNode): string {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text ?? "";
    else if (child.type.name === "hardBreak") text += "\n";
  });
  return text;
}

/** Every top-level block of `doc`, in order. */
export function docBlocks(doc: PMNode): DocBlock[] {
  const blocks: DocBlock[] = [];
  doc.forEach((node, offset, index) => {
    const text = blockText(node);
    blocks.push({
      number: index + 1,
      node,
      from: offset,
      to: offset + node.nodeSize,
      text,
      heading:
        node.type.name === "heading" ? { level: Number(node.attrs.level) || 1, text: collapse(text) } : null,
    });
  });
  return blocks;
}

/** The doc's text form: its blocks' text, a line break between each. */
export function docText(blocks: readonly DocBlock[]): string {
  return blocks.map((block) => block.text).join("\n");
}

/** How many characters a run of blocks holds in the text form, line breaks between them included. */
export function textSize(blocks: readonly DocBlock[]): number {
  if (blocks.length === 0) return 0;
  return blocks.reduce((sum, block) => sum + block.text.length, 0) + blocks.length - 1;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The block range a section covers, inclusive, by block number. */
export type BlockSpan = { from: number; to: number };

/**
 * The section a heading opens: from it to the block before the next heading
 * at its level or above, or the doc's end.
 */
export function sectionOf(blocks: readonly DocBlock[], headingNumber: number): BlockSpan {
  const heading = blocks[headingNumber - 1]?.heading;
  if (!heading) return { from: headingNumber, to: headingNumber };
  let to = blocks.length;
  for (let i = headingNumber; i < blocks.length; i++) {
    const next = blocks[i].heading;
    if (next && next.level <= heading.level) {
      to = i;
      break;
    }
  }
  return { from: headingNumber, to };
}

/** How many characters of a section's opening a repeated heading carries as its lead. */
export const LEAD_CHARS = 70;

export type OutlineEntry = {
  level: number;
  text: string;
  /** The block number the heading is. */
  block: number;
  /** The section's size in the text form, heading included. */
  chars: number;
  /**
   * The opening of the section, for a heading whose text occurs more than
   * once — an imported chat puts every turn under its author's name, and an
   * outline of "Claude" eighty times says nothing.
   */
  lead?: string;
};

export type DocOutline = {
  entries: OutlineEntry[];
  /** How many headings lie deeper than `depth` kept, within what the outline covers. */
  deeper: number;
};

/**
 * The outline, flat: one entry per heading, its level and block number
 * placing it — a tree would say nothing more, and spend tokens on brackets.
 *
 * `within` keeps the headings inside one section, the section's own heading
 * first. `depth` keeps the top levels only, counted from the shallowest level
 * the outline covers, so a chat's turns can be read first and its long
 * replies opened afterwards.
 */
export function docOutline(
  blocks: readonly DocBlock[],
  opts: { depth?: number; within?: BlockSpan } = {},
): DocOutline {
  const span = opts.within ?? { from: 1, to: blocks.length };
  const headings = blocks.filter((block) => block.heading && block.number >= span.from && block.number <= span.to);
  if (headings.length === 0) return { entries: [], deeper: 0 };

  // Repeated across the whole doc, not just the range: a section of a chat
  // still has a dozen "Claude" headings, and the lead is what tells them apart.
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.heading) counts.set(block.heading.text, (counts.get(block.heading.text) ?? 0) + 1);
  }

  const shallowest = Math.min(...headings.map((block) => block.heading!.level));
  const deepestKept = opts.depth === undefined ? Infinity : shallowest + Math.max(1, opts.depth) - 1;
  const entries: OutlineEntry[] = [];
  let deeper = 0;
  for (const block of headings) {
    const heading = block.heading!;
    if (heading.level > deepestKept) {
      deeper++;
      continue;
    }
    const section = sectionOf(blocks, block.number);
    const entry: OutlineEntry = {
      level: heading.level,
      text: heading.text,
      block: block.number,
      chars: textSize(blocks.slice(section.from - 1, section.to)),
    };
    if ((counts.get(heading.text) ?? 0) > 1) {
      const lead = leadOf(blocks.slice(section.from, section.to));
      if (lead) entry.lead = lead;
    }
    entries.push(entry);
  }
  return { entries, deeper };
}

function leadOf(blocks: readonly DocBlock[]): string {
  const text = collapse(blocks.map((block) => block.text).join(" "));
  if (text.length <= LEAD_CHARS) return text;
  const cut = text.slice(0, LEAD_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > LEAD_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The heading a block sits under: the nearest heading at or before it. */
export function headingAbove(blocks: readonly DocBlock[], blockNumber: number): DocBlock | null {
  for (let i = Math.min(blockNumber, blocks.length) - 1; i >= 0; i--) {
    if (blocks[i].heading) return blocks[i];
  }
  return null;
}

/** The blocks a ProseMirror range touches, by number. */
export function blocksOfRange(blocks: readonly DocBlock[], from: number, to: number): BlockSpan | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const block of blocks) {
    if (block.to <= from || block.from >= Math.max(to, from + 1)) continue;
    first ??= block.number;
    last = block.number;
  }
  return first === null || last === null ? null : { from: first, to: last };
}

export type HeadingLookup =
  | { kind: "found"; block: DocBlock }
  | { kind: "none" }
  | { kind: "ambiguous"; blocks: number[]; total: number }
  | { kind: "not-heading" };

/**
 * A heading named by its text or its block number. Text is compared under the
 * quote matcher's folding (typographic quotes and dashes, whitespace), and a
 * text that heads more than one section is refused with where they are; the
 * outline numbers them all, so a block number always works.
 */
export function findHeading(blocks: readonly DocBlock[], name: string | number, cap = 5): HeadingLookup {
  if (typeof name === "number") {
    const block = blocks[name - 1];
    if (!block) return { kind: "none" };
    return block.heading ? { kind: "found", block } : { kind: "not-heading" };
  }
  const wanted = normalizeForMatch(name).text;
  const found = blocks.filter((block) => block.heading && normalizeForMatch(block.heading.text).text === wanted);
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "ambiguous", blocks: found.slice(0, cap).map((b) => b.number), total: found.length };
  return { kind: "found", block: found[0] };
}

/**
 * Splits a doc into the passages `search` ranks when it is `within` the doc
 * (docs/MCP.md §6): each heading through to the block before the next
 * heading of any level, the text before the first heading as a passage of its
 * own, and any passage longer than about `maxChars` cut into runs of whole
 * top-level blocks. Ending at the next heading of *any* level, rather than at
 * the next at its own level as a section read does, is what keeps passages
 * from nesting: each block is ranked once, under the nearest heading above
 * it, and a hit's heading and block numbers name exactly the text that
 * matched.
 */
export function searchSections(blocks: readonly DocBlock[], maxChars = 2000): BlockSpan[] {
  const starts: number[] = [];
  blocks.forEach((block) => {
    if (block.heading || block.number === 1) starts.push(block.number);
  });
  const spans: BlockSpan[] = [];
  starts.forEach((start, index) => {
    const end = (starts[index + 1] ?? blocks.length + 1) - 1;
    let from = start;
    let size = 0;
    for (let n = start; n <= end; n++) {
      const length = blocks[n - 1].text.length + 1;
      if (size > 0 && size + length > maxChars) {
        spans.push({ from, to: n - 1 });
        from = n;
        size = 0;
      }
      size += length;
    }
    spans.push({ from, to: end });
  });
  return spans;
}
