import type { Node as PMNode } from "@tiptap/pm/model";

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
