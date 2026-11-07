import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { getAnnotationAnchorRanges, getAnnotationEdgeRanges } from "./annotation-highlight-extension";
import { chipPositions, rangeWithEdgeChips, resolveAnchorInDoc, type ChipRecord } from "./anchors";

export type AnnotationMarkRange = { from: number; to: number };

// Where each annotation's anchor *currently* is, read off a live ProseMirror
// document rather than off the database.
//
// This is the doc-side counterpart to a comment thread's stored
// `anchorFrom`/`anchorTo` columns, and it has to be computed rather than
// fetched because a doc annotation deliberately has no stored offset: its
// anchor is an `annotation` mark inside the doc's own ydoc (PLAN.md §12i,
// annotation-extension.ts's header). `getDocAnnotationsAsThreads`
// (annotation-data.ts) answers the neighbouring question — *whether* a mark
// exists — but does it against `Doc.proseJson`, which is a store-debounce
// snapshot and therefore stale by seconds while anyone is typing. Positioning
// a margin note against a stale snapshot puts the card next to the wrong
// paragraph, so every margin-note surface resolves through this instead.
//
// One pass for every id, not a scan per annotation: the reading views re-run
// this on each remote keystroke and the editing view on each local one, so an
// O(document × annotations) shape would be the wrong one to reach for.
//
// A mark's text run can be split by other marks (or by a later edit landing
// inside it), so the same id legitimately appears at several positions; the
// range returned spans from the first to the last, which is what "where is
// this annotation" means for anchoring purposes.
//
// PLAN.md §18d — this same map is the input a future "reconcile attached vs.
// detached against the live document" pass needs (the doc-side sibling of the
// post side's remap-on-publish, §5). Nothing consumes it that way yet; it is
// built here rather than inline in each surface so that when something does,
// there is one definition of "presently anchored" rather than three.
export function collectAnnotationMarkRanges(doc: PMNode): Map<string, AnnotationMarkRange> {
  const ranges = new Map<string, AnnotationMarkRange>();

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name !== "annotation") continue;
      const id = mark.attrs.id as string | null;
      if (!id) continue;
      const existing = ranges.get(id);
      if (existing) {
        existing.from = Math.min(existing.from, pos);
        existing.to = Math.max(existing.to, pos + node.nodeSize);
      } else {
        ranges.set(id, { from: pos, to: pos + node.nodeSize });
      }
    }
  });

  return ranges;
}

// PLAN.md §13o — where every annotation on this surface currently is,
// whichever mechanism it was anchored with. The two are resolved in
// completely different places (a mark is read straight off the document here;
// a stored offset is tracked per transaction by
// annotation-highlight-extension.ts's plugin state) and this is the one
// function that has to know both exist, so no rail or jump target has to.
//
// A mark wins a collision, though there is no way to produce one:
// postAnnotation writes one mechanism or the other and never both, and a
// row's `anchorFrom` being null *is* "look for a mark instead". The ordering
// is stated rather than left to Map insertion order in case that invariant is
// ever loosened — the mark is the anchor that cannot drift, so it is the one
// to believe.
//
// A mark-anchored passage that reaches over an entity chip is the third
// case, and wins over its own mark: a mark can't sit on a chip, so the mark's
// hull stops short of one at the passage's edge, and a passage that is a
// chip alone has no mark at all. The plugin resolves those by instance id
// (docs/ENTITY_CHIPS.md, step 1, item 11).
export function resolveAnnotationRanges(state: EditorState): Map<string, AnnotationMarkRange> {
  const ranges = new Map(getAnnotationAnchorRanges(state));
  for (const [id, range] of collectAnnotationMarkRanges(state.doc)) {
    ranges.set(id, range);
  }
  for (const [id, range] of getAnnotationEdgeRanges(state)) {
    ranges.set(id, range);
  }
  return ranges;
}

/**
 * `resolveAnnotationRanges` for a document with no editor around it — the MCP
 * server's reads (docs/MCP.md §9), which hold a doc decoded from its stored
 * row rather than an editor state. Built from the same two halves: the marks
 * read straight off the document, and each column anchor resolved the way the
 * reading view's plugin resolves it (`resolveAnchorInDoc`). A mark wins a
 * collision, for the reason given above.
 */
export function resolveAnnotationRangesInNode(
  doc: PMNode,
  anchors: readonly { id: string; anchorFrom: number | null; anchorTo: number | null; quotedText: string; chips?: readonly ChipRecord[] }[],
): Map<string, AnnotationMarkRange> {
  const ranges = new Map<string, AnnotationMarkRange>();
  for (const anchor of anchors) {
    if (anchor.anchorFrom === null || anchor.anchorTo === null || !anchor.quotedText) continue;
    const range = resolveAnchorInDoc(doc, anchor.anchorFrom, anchor.anchorTo, anchor.quotedText, undefined, anchor.chips);
    if (range) ranges.set(anchor.id, range);
  }
  const marks = collectAnnotationMarkRanges(doc);
  for (const [id, range] of marks) {
    ranges.set(id, range);
  }
  // A mark-anchored passage's edge chips: no offsets, and chips on record.
  const edges = anchors.filter((anchor) => anchor.anchorFrom === null && anchor.chips && anchor.chips.length > 0);
  if (edges.length > 0) {
    const chipAt = chipPositions(doc);
    for (const anchor of edges) {
      const range = rangeWithEdgeChips(doc, marks.get(anchor.id) ?? null, anchor.chips!, chipAt);
      if (range) ranges.set(anchor.id, range);
    }
  }
  return ranges;
}
