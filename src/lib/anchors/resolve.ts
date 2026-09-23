import type { Node as PMNode } from "@tiptap/pm/model";
import { findQuoteOccurrences } from "../quote-occurrences";
import type { AnchorRange } from "./types";

export type { AnchorRange } from "./types";

// PLAN.md §13o — the one rule for "do these offsets still name this text",
// shared by every surface that has to answer it, so none of them can drift
// on what counts as a match:
//
//   - server/ydoc-hooks.ts's handleApplyAnnotationMark, deciding where to
//     put the doc editor's mark (§12i's "the one place it can miss");
//   - capture.ts beside this file, deciding what a reading-view annotation
//     stores, against the state its ydocUpdateId stamps;
//   - annotation-highlight-extension.ts, deciding where a card sits *now*.
//
// PLAN.md §20h moved it here from src/lib/annotation-anchors.ts unchanged. It
// is the resolve half of the shared anchor library, and it is shared by
// *mechanism* rather than by consumer: any `DOC_RANGE` anchor answers this
// question the same way, whether the row that holds it belongs to an
// annotation or to a tag assignment (§20b). Nothing about it is
// annotation-specific, which is exactly why the old name had stopped being
// accurate.
//
// Cheapest first, and deliberately only two steps. Exact offsets are the
// overwhelmingly common case and cost nothing. The fallback is a whole-
// document scan for the quote, accepted only when it finds *exactly one*
// occurrence — several occurrences means the anchor is genuinely ambiguous
// and guessing would put the annotation on someone else's sentence. Zero or
// several is null: unanchored, which every caller already renders as
// document-level rather than as an error (§12h).
//
// A quote spanning a block boundary covers more positions than it has
// characters (a paragraph break is two or more positions and one separator),
// so a search sliding a `quotedText.length` window can never see it. What
// closes that gap is the *range's own width*: every search here also slides a
// window of `to - from` positions, the width the anchor had when its offsets
// were last right, which finds the passage anywhere for as long as its own
// block structure is unchanged — an edit to earlier blocks moves it, it does
// not reshape it. Each candidate is still verified by `textBetween` alone, so
// this is not the separator re-implementation COLLAB.md §4 reverted as too
// brittle. An edit *inside* a multi-block passage still detaches it, which is
// the text-verified contract rather than a gap: the quote no longer matches.
//
// A raw selection can include a boundary token at either end (a drag that
// starts at the end of the previous paragraph), so a range can also be wider
// than its quote within one block, and a window of that width then matches
// the same passage from more than one start. Every match is therefore
// tightened to the narrowest range with the same text, and duplicates are
// dropped, before the exactly-one rule counts them.
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
  const widths = searchWidths(quotedText, to - from, node.content.size);
  if (near) {
    const windowed = distinctMatches(
      node,
      quotedText,
      widths.flatMap((width) => findQuoteOccurrencesNear(node, quotedText, near.pos, near.radius, width)),
    );
    if (windowed.length === 1) return windowed[0];
  }
  const occurrences = distinctMatches(
    node,
    quotedText,
    widths.flatMap((width) => findQuoteOccurrences(node, quotedText, width)),
  );
  return occurrences.length === 1 ? occurrences[0] : null;
}

// The quote's length, plus the range's own width when that differs and is a
// width at all — offsets from a stale row can be inverted, negative or past
// the end, and those have no width worth searching at. Only a range that
// crosses a boundary (or carries one at an edge) costs a second pass.
function searchWidths(quotedText: string, width: number, size: number): number[] {
  return width > 0 && width <= size && width !== quotedText.length ? [quotedText.length, width] : [quotedText.length];
}

// Tighten each match past any edge position that contributes no text (a
// block's opening or closing token), then drop duplicates — so one passage
// found at two widths, or at one width from two starts, counts once.
function distinctMatches(node: PMNode, quotedText: string, matches: AnchorRange[]): AnchorRange[] {
  const seen = new Map<string, AnchorRange>();
  for (const match of matches) {
    let { from, to } = match;
    while (to - from > 1 && node.textBetween(from + 1, to, " ") === quotedText) from++;
    while (to - from > 1 && node.textBetween(from, to - 1, " ") === quotedText) to--;
    seen.set(`${from}:${to}`, { from, to });
  }
  return [...seen.values()];
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
  width: number,
): AnchorRange[] {
  const size = node.content.size;
  const first = Math.max(0, pos - radius);
  const last = Math.min(size - width, pos + radius);
  const found: AnchorRange[] = [];
  for (let from = first; from <= last; from++) {
    if (node.textBetween(from, from + width, " ") === quotedText) {
      found.push({ from, to: from + width });
    }
  }
  return found;
}
