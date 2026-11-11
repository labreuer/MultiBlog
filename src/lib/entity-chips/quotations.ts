import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CHIP_ANCHOR_TEXT, ENTITY_CHIP, type Quotation } from "./types";

// docs/CITATIONS.md, "What quote:prev and quote:next find" — the quotation a
// citation points at when its referent is `quote:prev` or `quote:next`: the
// one finder, run wherever chips are collected from a body (renderings.ts),
// so the editor, a static render, a post's text and a Markdown read all find
// the same words. The rendering that reads it reads no doc (docs/ENTITY_CHIPS.md,
// rule 2): this is what hands it the words.
//
// - `quote:prev` walks back within the textblock over spaces, closing
//   punctuation and other citation chips, so two citations can share one
//   quotation. A closing `"` or `”` there ends the quotation, which is the
//   double-quoted run it closes. Otherwise, a chip that ends a blockquote, or
//   stands alone in the paragraph right after one, points at the blockquote.
// - `quote:next` takes the first quotation opening after the chip, before the
//   next citation, in the same textblock; otherwise the blockquote right after
//   the chip's textblock.
//
// Browser-safe and dependency-free, over ProseMirror nodes and their JSON
// alike. Positions come only from a ProseMirror node, for the popover's
// highlight; JSON has none to give.

const QUOTE_PREV = "quote:prev";
const QUOTE_NEXT = "quote:next";

/** Whether a chip's raw fields point at a quotation beside it: what decides whether the finder runs at all. */
export function pointsAtQuotation(kind: string, data: Record<string, unknown>): boolean {
  return kind === "citation" && (data.referent === QUOTE_PREV || data.referent === QUOTE_NEXT);
}

/** What the finder reads of a tree, a ProseMirror node's or a JSON body's. */
type Access<N> = {
  type(node: N): string;
  text(node: N): string;
  attrs(node: N): Record<string, unknown>;
  children(node: N): readonly N[];
  /** A node's ProseMirror size, or null for JSON, which has no positions. */
  size(node: N): number | null;
};

const pmAccess: Access<PMNode> = {
  type: (node) => node.type.name,
  text: (node) => node.text ?? "",
  attrs: (node) => node.attrs,
  children: (node) => node.content.content,
  size: (node) => node.nodeSize,
};

const jsonAccess: Access<JSONContent> = {
  type: (node) => node.type ?? "",
  text: (node) => node.text ?? "",
  attrs: (node) => node.attrs ?? {},
  children: (node) => node.content ?? [],
  size: () => null,
};

// A textblock flattened: one character per character of text, U+FFFC for a
// chip or any other inline leaf, a space for a hard break.
type Flat = {
  text: string;
  /** The position each character stands at, when the tree has positions. */
  pos: (number | null)[];
  /** The chips at their flat offsets: whether each is a citation, and its fields. */
  chips: Map<number, { citation: boolean; data: Record<string, unknown> }>;
  /** Where the textblock's content ends, when the tree has positions. */
  end: number | null;
};

const INLINE = new Set(["text", ENTITY_CHIP, "hardBreak"]);

function flatten<N>(block: N, contentStart: number | null, access: Access<N>): Flat {
  const flat: Flat = { text: "", pos: [], chips: new Map(), end: contentStart };
  let pos = contentStart;
  for (const child of access.children(block)) {
    const type = access.type(child);
    if (type === "text") {
      const text = access.text(child);
      for (let i = 0; i < text.length; i++) flat.pos.push(pos === null ? null : pos + i);
      flat.text += text;
    } else {
      if (type === ENTITY_CHIP) {
        const attrs = access.attrs(child);
        const data = typeof attrs.data === "object" && attrs.data !== null ? (attrs.data as Record<string, unknown>) : {};
        flat.chips.set(flat.text.length, { citation: attrs.kind === "citation", data });
      }
      flat.text += type === "hardBreak" ? " " : CHIP_ANCHOR_TEXT;
      flat.pos.push(pos);
    }
    const size = access.size(child);
    pos = pos === null || size === null ? null : pos + size;
  }
  flat.end = pos;
  return flat;
}

// What `quote:prev` walks back over: space, closing punctuation and (checked
// apart) citation chips. A quotation mark is checked before it is skipped.
const SKIPPED = /[\s.,;:!?)\]}»›’'—–-]/u;

/** The text of a run of a textblock, every chip a space. */
const runText = (flat: Flat, from: number, to: number) => flat.text.slice(from, to).replaceAll(CHIP_ANCHOR_TEXT, " ").trim();

function runQuotation(flat: Flat, from: number, to: number): Quotation | null {
  const text = runText(flat, from, to);
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const start = flat.pos[from];
  const last = flat.pos[to - 1];
  return { text, from: start ?? null, to: last === null || last === undefined ? null : last + 1 };
}

/** The double-quoted run `quote:prev` points at from the chip at flat offset `at`, or null. */
function quotationBefore(flat: Flat, at: number): Quotation | null {
  let i = at - 1;
  for (; i >= 0; i--) {
    const ch = flat.text[i];
    if (ch === '"' || ch === "”") break;
    if (ch === CHIP_ANCHOR_TEXT) {
      if (flat.chips.get(i)?.citation) continue;
      return null;
    }
    if (!SKIPPED.test(ch)) return null;
  }
  if (i < 0) return null;
  const close = flat.text[i];
  const opens = close === "”" ? ["“", '"'] : ['"', "“"];
  for (const open of opens) {
    const o = flat.text.lastIndexOf(open, i - 1);
    if (o >= 0) return runQuotation(flat, o + 1, i);
  }
  return null;
}

/** The first double-quoted run `quote:next` points at from the chip at flat offset `at`, before the next citation, or null. */
function quotationAfter(flat: Flat, at: number): Quotation | null {
  for (let i = at + 1; i < flat.text.length; i++) {
    const ch = flat.text[i];
    if (ch === CHIP_ANCHOR_TEXT && flat.chips.get(i)?.citation) return null;
    if (ch !== '"' && ch !== "“") continue;
    const closes = ch === "“" ? ["”", '"'] : ['"', "”"];
    for (const close of closes) {
      const c = flat.text.indexOf(close, i + 1);
      if (c >= 0) return runQuotation(flat, i + 1, c);
    }
    return null;
  }
  return null;
}

/** Whether nothing but spaces, closing punctuation and citation chips stands after flat offset `at`. */
function endsBlock(flat: Flat, at: number): boolean {
  for (let i = at + 1; i < flat.text.length; i++) {
    const ch = flat.text[i];
    if (ch === CHIP_ANCHOR_TEXT ? !flat.chips.get(i)?.citation : !SKIPPED.test(ch)) return false;
  }
  return true;
}

/** Whether a textblock holds no letter or digit outside its chips. */
const standsAlone = (flat: Flat) => !/[\p{L}\p{N}]/u.test(flat.text.replaceAll(CHIP_ANCHOR_TEXT, ""));

type Found<N> = { node: N; start: number | null };

/** Every textblock inside `node`, in order, each with where its content starts. */
function textblocksIn<N>(node: N, start: number | null, access: Access<N>): Found<N>[] {
  const children = access.children(node);
  if (children.some((child) => INLINE.has(access.type(child)))) return [{ node, start: start === null ? null : start + 1 }];
  const found: Found<N>[] = [];
  let pos = start === null ? null : start + 1;
  for (const child of children) {
    found.push(...textblocksIn(child, pos, access));
    const size = access.size(child);
    pos = pos === null || size === null ? null : pos + size;
  }
  return found;
}

/** A blockquote's text, its textblocks joined by spaces, up to flat offset `upTo` of its last one when given. */
function blockquoteQuotation<N>(quote: Found<N>, access: Access<N>, upTo?: number): Quotation | null {
  const blocks = textblocksIn(quote.node, quote.start, access).map((block) => flatten(block.node, block.start, access));
  if (blocks.length === 0) return null;
  const last = blocks.length - 1;
  const text = blocks
    .map((flat, index) => runText(flat, 0, index === last && upTo !== undefined ? upTo : flat.text.length))
    .filter(Boolean)
    .join(" ");
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const end = upTo !== undefined ? (blocks[last].pos[upTo - 1] ?? null) : null;
  return {
    text,
    from: blocks[0].pos[0] ?? blocks[0].end,
    to: upTo !== undefined ? (end === null ? null : end + 1) : blocks[last].end,
  };
}

/**
 * The quotation each chip pointing at one is given, in doc order over every
 * chip in `root` (the order `chipsIn` and `chipsInJSON` meet them): a
 * `Quotation`, null where it points at one and none is found, and undefined
 * for a chip that points at none. `start` is where `root`'s own content
 * starts: 0 for a doc.
 */
function quotationsIn<N>(root: N, access: Access<N>, rootStart: number | null): (Quotation | null | undefined)[] {
  const out: (Quotation | null | undefined)[] = [];
  // Ancestors of the node being visited, each with where it starts, outermost first.
  const visit = (node: N, start: number | null, ancestors: Found<N>[], siblings: readonly Found<N>[], index: number) => {
    const children = access.children(node);
    if (!children.some((child) => INLINE.has(access.type(child)))) {
      const found: Found<N>[] = [];
      let pos = start === null ? null : start + (ancestors.length === 0 && rootStart === 0 ? 0 : 1);
      for (const child of children) {
        found.push({ node: child, start: pos });
        const size = access.size(child);
        pos = pos === null || size === null ? null : pos + size;
      }
      const self = { node, start };
      found.forEach((child, i) => visit(child.node, child.start, [...ancestors, self], found, i));
      return;
    }
    const contentStart = start === null ? null : start + (ancestors.length === 0 && rootStart === 0 ? 0 : 1);
    const flat = flatten(node, contentStart, access);
    for (const [at, chip] of flat.chips) {
      if (!chip.citation || (chip.data.referent !== QUOTE_PREV && chip.data.referent !== QUOTE_NEXT)) {
        out.push(undefined);
        continue;
      }
      out.push(chip.data.referent === QUOTE_PREV ? findPrev(flat, at, node, ancestors, siblings, index) : findNext(flat, at, siblings, index));
    }
  };

  const findPrev = (flat: Flat, at: number, block: N, ancestors: Found<N>[], siblings: readonly Found<N>[], index: number): Quotation | null => {
    const quoted = quotationBefore(flat, at);
    if (quoted) return quoted;
    // The chip ends a blockquote: the textblock is that blockquote's last, and nothing but the chip's company follows it.
    const quote = [...ancestors].reverse().find((ancestor) => access.type(ancestor.node) === "blockquote");
    if (quote && endsBlock(flat, at)) {
      const blocks = textblocksIn(quote.node, quote.start, access);
      if (blocks.length > 0 && blocks[blocks.length - 1].node === block) return blockquoteQuotation(quote, access, at);
    }
    // It stands alone in the paragraph right after one.
    const before = siblings[index - 1];
    if (before && access.type(before.node) === "blockquote" && standsAlone(flat)) return blockquoteQuotation(before, access);
    return null;
  };

  const findNext = (flat: Flat, at: number, siblings: readonly Found<N>[], index: number): Quotation | null => {
    const quoted = quotationAfter(flat, at);
    if (quoted) return quoted;
    const after = siblings[index + 1];
    return after && access.type(after.node) === "blockquote" ? blockquoteQuotation(after, access) : null;
  };

  visit(root, rootStart, [], [{ node: root, start: rootStart }], 0);
  return out;
}

/** The quotations beside the chips of a ProseMirror node, in the order `chipsIn` meets them, its positions those `chipsIn` gives. */
export function quotationsInNode(node: PMNode): (Quotation | null | undefined)[] {
  // `chipsIn` gives positions relative to the node's content, as `descendants` does.
  return quotationsIn(node, pmAccess, 0);
}

/** The same over ProseMirror JSON, with no positions. */
export function quotationsInJSON(doc: JSONContent): (Quotation | null | undefined)[] {
  return quotationsIn(doc, jsonAccess, null);
}
