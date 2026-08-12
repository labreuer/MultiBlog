import type { Node as PMNode } from "@tiptap/pm/model";

// The separator `textBetween` is called with everywhere this codebase
// re-finds a quote. It has to match, or the flattening below would search a
// string the callers never asked about.
const BLOCK_SEPARATOR = " ";

// `synthetic` marks a block separator: a character `textBetween` invents at a
// block boundary, with no counterpart in the document. It can sit anywhere in
// a match except the very start — see the two notes at its push site and in
// findQuoteOccurrences.
type FlatChar = { from: number; to: number; synthetic: boolean };

type FlatText = {
  text: string;
  // The document range of each character in `text`, so a match found by
  // string search can be turned back into positions without assuming
  // anything about how document positions and text offsets relate.
  chars: FlatChar[];
};

// `doc.textBetween(0, size, " ")`, but retaining where each character came
// from — which is the whole point, and what the previous sliding-window
// implementation could not do.
//
// **Exact parity with `textBetween` is required, not merely nice.** The
// separator rule below mirrors prosemirror-model's: a separator is emitted
// before every *textblock* except the first, and never for a non-textblock
// wrapper (a `blockquote` contributes nothing; the paragraph inside it does)
// or for a leaf like an image. `descendants` visits a parent before its
// children, exactly as `textBetween`'s own `nodesBetween` walk does, so
// emitting the separator on arrival at the textblock puts it in the same
// place. An empty paragraph still counts, so it still yields a separator with
// nothing after it — matching `textBetween` character for character, blank
// runs included.
function flattenText(node: PMNode): FlatText {
  let text = "";
  const chars: FlatChar[] = [];
  let first = true;

  node.descendants((child, pos) => {
    if (child.isText) {
      const value = child.text ?? "";
      for (let i = 0; i < value.length; i++) {
        text += value[i];
        chars.push({ from: pos + i, to: pos + i + 1, synthetic: false });
      }
    } else if (child.isTextblock) {
      if (first) {
        first = false;
      } else {
        text += BLOCK_SEPARATOR;
        // `to` is one *inside* the block, not at its boundary. A separator is
        // emitted by `textBetween` on *arriving* at a textblock, so a range
        // that is to read back with a trailing separator has to extend past
        // the block's opening token — stopping at `pos` would end the range
        // before the block it is entering, and the separator would vanish.
        // This is not hypothetical: selecting from mid-paragraph to the start
        // of the next one produces exactly such a range.
        chars.push({ from: pos, to: pos + 1, synthetic: true });
      }
    }
    return true;
  });

  return { text, chars };
}

// Every range whose text is exactly `quotedText` — the fallback search
// PLAN.md §12i/§13f describes for when the original offsets no longer land
// where they used to (the document changed underneath a captured selection).
//
// Shared between server/ydoc-hooks.ts's handleApplyAnnotationMark (walking a
// plain prosemirror-model Node built server-side) and useSelectionPopover's
// pending-selection re-resolution (walking a live editor's ProseMirror
// state.doc) — both are PMNode instances, so one implementation serves both
// call sites without the two ever drifting on what "find the quote again"
// means. The two differ only in what they do with an ambiguous result, which
// is each caller's own decision: the server refuses to guess, the reader's
// popover takes the nearest.
//
// **Now matches across block boundaries**, which the previous implementation
// documented that it could not: it tested `textBetween(from, from + len)`
// windows, and a paragraph break costs more than one position while
// contributing one separator character, so every window spanning one
// undercounted and no multi-paragraph quote was ever found. That made a
// selection spanning a paragraph break unrecoverable by construction — it
// could only ever be closed, never re-anchored.
//
// Also O(document) rather than O(document × quote length), since the search
// is now one `indexOf` sweep over flattened text instead of a `textBetween`
// call per candidate position. Not the reason for the change, but it does
// retire the "rare operation, don't optimize" caveat this used to carry.
export function findQuoteOccurrences(node: PMNode, quotedText: string): { from: number; to: number }[] {
  if (!quotedText) return [];

  const { text, chars } = flattenText(node);
  const occurrences: { from: number; to: number }[] = [];

  for (let index = text.indexOf(quotedText); index !== -1; index = text.indexOf(quotedText, index + 1)) {
    const start = chars[index];
    const end = chars[index + quotedText.length - 1];
    if (!start || !end) continue;
    // A match *starting* on a separator can never read back as itself, and no
    // real selection produces one: `textBetween` suppresses the separator
    // before the first textblock it meets, so a range beginning at a block
    // boundary comes back without the leading space that was searched for.
    // Skipping keeps `textBetween(from, to) === quotedText` true of every
    // range returned, which is what both callers rely on.
    if (start.synthetic) continue;
    occurrences.push({ from: start.from, to: end.to });
  }

  return occurrences;
}
