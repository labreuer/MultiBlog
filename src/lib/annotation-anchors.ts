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
//
// `near` is the middle step, and exists for one reason: without it this is
// unusable on a live surface. A full scan is O(document × quote) with a
// `textBetween` call per position, and a reading view re-resolves every
// anchor on every remote keystroke — so a 20k-character doc with twenty
// annotations would pay tens of thousands of `textBetween` calls per
// keystroke somebody else types. When the caller knows roughly where the
// text was a moment ago it says so, and the search starts as a window around
// that. A hit inside the window is *more* trustworthy than a globally unique
// match, not less — it is the occurrence nearest where this anchor already
// was — so this strengthens tracking rather than trading it away, and the
// global exactly-one rule is still the fallback when the window comes up
// empty or ambiguous.
export function resolveAnchorInDoc(
  node: PMNode,
  from: number,
  to: number,
  quotedText: string,
  near?: { pos: number; radius: number },
): AnchorRange | null {
  if (!quotedText) return null;
  if (from >= 0 && to > from && to <= node.content.size && node.textBetween(from, to, " ") === quotedText) {
    return { from, to };
  }
  if (near) {
    const windowed = findQuoteOccurrencesNear(node, quotedText, near.pos, near.radius);
    if (windowed.length === 1) return windowed[0];
  }
  const occurrences = findQuoteOccurrences(node, quotedText);
  return occurrences.length === 1 ? occurrences[0] : null;
}

// findQuoteOccurrences restricted to start positions within `radius` of
// `pos`. Deliberately a separate small function rather than a parameter on
// that one: it is shared with server/ydoc-hooks.ts, where there is no "where
// was it a moment ago" to hint with, and a windowing option nothing on that
// path can supply would read as if there were.
function findQuoteOccurrencesNear(
  node: PMNode,
  quotedText: string,
  pos: number,
  radius: number,
): AnchorRange[] {
  const size = node.content.size;
  const len = quotedText.length;
  const first = Math.max(0, pos - radius);
  const last = Math.min(size - len, pos + radius);
  const found: AnchorRange[] = [];
  for (let from = first; from <= last; from++) {
    if (node.textBetween(from, from + len, " ") === quotedText) {
      found.push({ from, to: from + len });
    }
  }
  return found;
}
