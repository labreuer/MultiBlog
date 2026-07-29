import type { Node as PMNode } from "@tiptap/pm/model";
import { findQuoteOccurrences } from "./quote-occurrences";
import { perfMeasure } from "./perf-monitor";

// PLAN.md §14b/§14d — a doc link's external anchor, stored as `DocLink.mark`
// (Json). `text` is doc.textBetween(from, to, " ") at capture time — the
// same value findQuoteOccurrences searches for; `before`/`after` are up to
// CONTEXT_CHARS of surrounding text, used to break ties when `text` occurs
// more than once; `blocks` is how many block nodes the selection spanned,
// which resolveAnchor needs (see below). `v` exists because this is the one
// column in the schema whose shape will change if the inline-mark path
// (mark_id) ever lands.
export type DocLinkMark = {
  v: 1;
  from: number;
  to: number;
  text: string;
  before: string;
  after: string;
  blocks: number;
};

const CONTEXT_CHARS = 50;

// Prisma types `mark` as JsonValue — untrusted shape, same stance
// AnnotationColorStyles.tsx takes on a color string from the DB. Every read
// goes through this rather than a cast.
export function parseDocLinkMark(value: unknown): DocLinkMark | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    v.v !== 1 ||
    typeof v.from !== "number" ||
    typeof v.to !== "number" ||
    typeof v.text !== "string" ||
    typeof v.before !== "string" ||
    typeof v.after !== "string" ||
    typeof v.blocks !== "number"
  ) {
    return null;
  }
  return { v: 1, from: v.from, to: v.to, text: v.text, before: v.before, after: v.after, blocks: v.blocks };
}

function countBlocks(doc: PMNode, from: number, to: number): number {
  let count = 0;
  doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock) count++;
  });
  return count;
}

// Captures a fresh anchor from a live selection — called once, at link
// creation (§14i). Never called during resolution (see resolveAnchor below).
export function captureAnchor(doc: PMNode, from: number, to: number): DocLinkMark {
  const size = doc.content.size;
  return {
    v: 1,
    from,
    to,
    text: doc.textBetween(from, to, " "),
    before: doc.textBetween(Math.max(0, from - CONTEXT_CHARS), from, " "),
    after: doc.textBetween(to, Math.min(size, to + CONTEXT_CHARS), " "),
    blocks: countBlocks(doc, from, to),
  };
}

export type ResolvedAnchor = { anchored: true; from: number; to: number } | { anchored: false };

function contextMatches(doc: PMNode, occ: { from: number; to: number }, mark: DocLinkMark): boolean {
  const size = doc.content.size;
  const before = doc.textBetween(Math.max(0, occ.from - CONTEXT_CHARS), occ.from, " ");
  const after = doc.textBetween(occ.to, Math.min(size, occ.to + CONTEXT_CHARS), " ");
  return before === mark.before && after === mark.after;
}

// PLAN.md §14d — resolution order, cheapest first:
//   1. stored offsets still yield the stored text → use as-is, O(1).
//   2. otherwise findQuoteOccurrences: exactly one match → use it; several →
//      filter by before/after context, use the survivor if exactly one
//      remains; zero, or still ambiguous → unanchored.
// A selection spanning more than one block node skips step 2 entirely and
// degrades straight to unanchored on a step-1 mismatch —
// findQuoteOccurrences cannot match across a block boundary (its own header
// comment says why: a paragraph break costs two ProseMirror positions but
// emits one separator character, undercounting the from+len window once per
// boundary).
export function resolveAnchor(doc: PMNode, mark: DocLinkMark): ResolvedAnchor {
  if (mark.to <= doc.content.size && doc.textBetween(mark.from, mark.to, " ") === mark.text) {
    return { anchored: true, from: mark.from, to: mark.to };
  }
  if (mark.blocks > 1) {
    return { anchored: false };
  }

  const occurrences = findQuoteOccurrences(doc, mark.text);
  if (occurrences.length === 1) {
    return { anchored: true, ...occurrences[0] };
  }
  if (occurrences.length > 1) {
    const survivors = occurrences.filter((occ) => contextMatches(doc, occ, mark));
    if (survivors.length === 1) {
      return { anchored: true, ...survivors[0] };
    }
  }
  return { anchored: false };
}

export type StoredDocLink = { id: string; mark: DocLinkMark | null };

// What a rendering surface (LiveDocBody, and eventually the write column)
// needs per link to both resolve it (mark) and paint it once resolved
// (groupId/color/mine) — the resolved from/to positions are computed at
// render time, never stored on this type. `color` is already the final
// three-level cascade result (§14e: link override ?? group override ??
// author color); callers compute that once, not per resolve.
export type DocLinkInput = StoredDocLink & { groupId: string; color: string; mine: boolean };

// Memoized on (doc identity, links identity) — not an optimization but load-
// bearing (§14d step 3): the read column calls setContent, and therefore
// this, on every incoming remote update, and findQuoteOccurrences is
// O(doc size × text length) with no index. A factory rather than a module
// singleton, so each column (each with its own doc) gets its own cache
// slot instead of two columns thrashing one shared one.
export function createDocLinkResolver() {
  let lastDoc: PMNode | null = null;
  let lastLinks: StoredDocLink[] | null = null;
  let lastResult: Map<string, ResolvedAnchor> | null = null;

  return function resolveDocLinks(doc: PMNode, links: StoredDocLink[]): Map<string, ResolvedAnchor> {
    if (doc === lastDoc && links === lastLinks && lastResult) {
      return lastResult;
    }
    const result = perfMeasure("doc-link resolve", () => {
      const map = new Map<string, ResolvedAnchor>();
      for (const link of links) {
        map.set(link.id, link.mark ? resolveAnchor(doc, link.mark) : { anchored: false });
      }
      return map;
    });
    lastDoc = doc;
    lastLinks = links;
    lastResult = result;
    return result;
  };
}
