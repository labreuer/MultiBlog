import type { Node as PMNode } from "@tiptap/pm/model";
import { parsePdfTarget, type PdfTarget } from "../pdf-anchor";
import { SELECTOR_KINDS, type SelectorKind } from "./types";

// PLAN.md §20b — the part selector's opaque half.
//
// `tag_anchor.selector` is jsonb, the same trade `pdf_target` and
// `doc_link.mark` already make: nothing in Postgres ever sorts or filters
// inside it, so it carries whatever the *kind* needs and costs no GIN index.
// What it must never become is a cast — **every jsonb read goes through a
// parse**, the `parseDocLinkMark`/`parsePdfTarget` convention, because a
// column is untrusted input whether a client wrote it or an older version of
// this code did.
//
// The kind and the blob travel together and are meaningless apart, which is
// why `parseSelector` takes both: a `PDF_TEXT` blob read as a `DOC_RANGE` is
// not a degraded anchor, it is a different thing entirely.
//
// PR 1 writes neither (§20h): every row it creates is whole-object, so
// `selector_kind` and `selector` are both null and the second CHECK in the
// migration keeps them null together. This file ships with its writers.

/**
 * The `DOC_RANGE` selector — offsets into a ydoc-backed document, expressed as
 * the *context* around them. The offsets and the quote themselves are real
 * columns (`anchor_from`, `anchor_to`, `quoted_text`), so they are deliberately
 * absent here; what the blob adds is what re-finding the range needs when the
 * offsets stop landing (COLLAB.md §3's before/after, and the block count that
 * says whether the selection crossed a paragraph break).
 *
 * Shaped like `DocLinkMark` and deliberately not *reusing* it. A doc link's
 * mark is a standalone anchor and repeats `from`/`to`/`text` inside the blob;
 * folding these two together is §20i's deferred `doc_link` migration, which
 * buys uniformity rather than capability and should happen — if it happens —
 * because it makes §14d's resolve path cheaper, not because the shapes rhyme.
 */
export type DocRangeSelector = {
  v: 1;
  /** Up to ~50 characters immediately before `anchor_from`, at capture time. */
  before: string;
  /** Up to ~50 characters immediately after `anchor_to`, at capture time. */
  after: string;
  /** How many textblocks the range spans — >1 means it crossed a block boundary. */
  blocks: number;
};

/**
 * The `PDF_TEXT` selector — a whole `PdfTarget` blob, verbatim.
 *
 * Renderer-neutral, which is docs/PDF.md invariant 3: swapping PDF.js for
 * another engine must be a rendering change and not a data migration. Reusing
 * `parsePdfTarget` rather than restating its shape is what keeps that
 * invariant in one place now that a PDF anchor can live in two tables.
 */
export type PdfTextSelector = PdfTarget;

export type AnchorSelector =
  | { kind: "DOC_RANGE"; selector: DocRangeSelector }
  | { kind: "PDF_TEXT"; selector: PdfTextSelector };

// How much surrounding text a DOC_RANGE selector carries. The window is in
// ProseMirror positions and the slice trims it to characters, so a range next
// to a run of block boundaries still gets its ~50 characters of real text
// rather than a window eaten by structure.
const CONTEXT_CHARS = 50;

/**
 * The `DocRangeSelector` blob for a resolved range — PR 2's writer for the
 * part-selector jsonb (§20b). Derived from the same materialized node the
 * offsets and quote came from (`captureAnchorInYdoc` is the caller), so all
 * four of `anchor_from`, `anchor_to`, `quoted_text`, `selector` describe one
 * document state by construction.
 *
 * Pure, and in this browser-safe half rather than beside its caller in
 * capture.ts, because nothing in it is server-shaped — it is the write-side
 * twin of `parseDocRangeSelector` above, and the unit suite exercises its
 * edges (a range at the document's start, a selection spanning blocks)
 * without dragging PrismaClient into the test process.
 */
export function deriveDocRangeSelector(node: PMNode, from: number, to: number): DocRangeSelector {
  const before = node.textBetween(Math.max(0, from - CONTEXT_CHARS * 2), from, " ").slice(-CONTEXT_CHARS);
  const after = node.textBetween(to, Math.min(node.content.size, to + CONTEXT_CHARS * 2), " ").slice(0, CONTEXT_CHARS);
  let blocks = 0;
  node.nodesBetween(from, to, (n) => {
    if (n.isTextblock) blocks++;
  });
  return { v: 1, before, after, blocks: Math.max(1, blocks) };
}

/** Narrows an untrusted string to a selector kind. Null for anything else, including "POST_RANGE" (§20i). */
export function parseSelectorKind(value: unknown): SelectorKind | null {
  return typeof value === "string" && (SELECTOR_KINDS as readonly string[]).includes(value)
    ? (value as SelectorKind)
    : null;
}

function parseDocRangeSelector(value: unknown): DocRangeSelector | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.before !== "string" || typeof v.after !== "string") return null;
  if (!Number.isInteger(v.blocks) || (v.blocks as number) < 1) return null;
  return { v: 1, before: v.before, after: v.after, blocks: v.blocks as number };
}

/**
 * The one entry point for reading an anchor row's `(selector_kind, selector)`
 * pair. Returns null when the kind is unknown or the blob doesn't match it —
 * which every caller renders as "whole object", the same degradation a lost
 * mark already gets (§12h), rather than as an error.
 */
export function parseSelector(kind: unknown, value: unknown): AnchorSelector | null {
  const selectorKind = parseSelectorKind(kind);
  if (!selectorKind) return null;
  if (selectorKind === "DOC_RANGE") {
    const selector = parseDocRangeSelector(value);
    return selector ? { kind: "DOC_RANGE", selector } : null;
  }
  const selector = parsePdfTarget(value);
  return selector ? { kind: "PDF_TEXT", selector } : null;
}
