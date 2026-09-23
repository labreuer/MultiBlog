import type { Node as PMNode } from "@tiptap/pm/model";

// Every from..from+quotedText.length window whose text matches quotedText
// exactly — the fallback search PLAN.md §12i/§13f describes for when the
// original offsets no longer land where they used to (the document changed
// underneath a captured selection). O(document size × quotedText length):
// fine for an occasional annotation submission or a pending-decoration
// re-resolution, not a per-keystroke path — same "don't over-optimize a
// rare operation" stance as the replay slider (§11h). Doesn't attempt to
// match across a block boundary (a paragraph break costs more than one
// position, so a naive from+len window undercounts there) — unless the
// caller knows the width in positions the quote last spanned and passes it,
// which is how resolveAnchorInDoc re-finds a multi-block anchor.
//
// Shared between server/ydoc-hooks.ts's handleApplyAnnotationMark (walking a
// plain prosemirror-model Node built server-side) and useSelectionPopover's
// pending-selection re-resolution (walking a live editor's ProseMirror
// state.doc) — both are PMNode instances with the same textBetween/
// content.size shape, so one implementation serves both call sites without
// the two ever drifting on what "find the quote again" means.
export function findQuoteOccurrences(
  node: PMNode,
  quotedText: string,
  width: number = quotedText.length,
): { from: number; to: number }[] {
  const occurrences: { from: number; to: number }[] = [];
  const size = node.content.size;
  for (let from = 0; from + width <= size; from++) {
    if (node.textBetween(from, from + width, " ") === quotedText) {
      occurrences.push({ from, to: from + width });
    }
  }
  return occurrences;
}
