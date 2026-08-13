import type { Node as PMNode } from "@tiptap/pm/model";
import { findQuoteOccurrences } from "./quote-occurrences";

export type AnchorRange = { from: number; to: number };

// PLAN.md §13o — the one rule for "do these offsets still name this text",
// shared by every surface that has to answer it, so none of them can drift
// on what counts as a match:
//
//   - server/ydoc-hooks.ts's handleApplyAnnotationMark, deciding where to
//     put the doc editor's mark (§12i's "the one place it can miss");
//   - annotation-anchor-capture.ts, deciding what a reading-view annotation
//     stores, against the state its ydocUpdateId stamps;
//   - collectAnnotationAnchors below, deciding where a card sits *now*.
//
// Cheapest first, and deliberately only two steps. Exact offsets are the
// overwhelmingly common case and cost nothing. The fallback is a whole-
// document scan for the quote, accepted only when it finds *exactly one*
// occurrence — several occurrences means the anchor is genuinely ambiguous
// and guessing would put the annotation on someone else's sentence. Zero or
// several is null: unanchored, which every caller already renders as
// document-level rather than as an error (§12h).
//
// It inherits findQuoteOccurrences' block-boundary limitation (COLLAB.md §3):
// a selection spanning a paragraph break can't be re-found once its offsets
// stop matching. That is a real gap and not worked around here — see the
// rejected rewrite in COLLAB.md §4 for why re-implementing textBetween's
// separator handling to close it was reverted as too brittle.
export function resolveAnchorInDoc(node: PMNode, from: number, to: number, quotedText: string): AnchorRange | null {
  if (!quotedText) return null;
  if (from >= 0 && to > from && to <= node.content.size && node.textBetween(from, to, " ") === quotedText) {
    return { from, to };
  }
  const occurrences = findQuoteOccurrences(node, quotedText);
  return occurrences.length === 1 ? occurrences[0] : null;
}
