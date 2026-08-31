import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { getAnnotationAnchorRanges } from "./annotation-highlight-extension";

export type AnnotationClickOptions = {
  // Fired with every distinct annotation id anchored over the clicked
  // position (more than one only when annotations overlap — both mechanisms
  // allow that: annotation-extension.ts's `excludes: ""` for marks, and
  // decoration-segments.ts's pre-splitting for stored offsets). Never fired
  // for a mousedown/mouseup that land at different positions, so dragging a
  // new selection that starts inside already-annotated text still falls
  // through to the normal onSelectionUpdate path instead of jumping away.
  onHit: (ids: string[], pos: number) => void;
};

// DocReadingBody's counterpart to AnnotatableArticle's quote-indicator badge
// click (quote-highlight-extension.ts's onIndicatorClick): a doc's
// annotation anchor is a mark in the document itself, not a decoration with
// its own clickable widget, so this reads the `annotation` mark straight off
// the clicked position (the standard ProseMirror technique — $pos.marks())
// rather than tracking resolved ranges the way doc-link-extension.ts's
// handleClick does for a decoration-based system. View-only — like DocLink,
// it contributes no schema of its own, so passing it through only the
// reading surface's own `extensions` option (never docContentExtensions)
// keeps the write column's editor untouched.
export const AnnotationClick = Extension.create<AnnotationClickOptions>({
  name: "annotationClick",

  addOptions() {
    return { onHit: () => {} };
  },

  addProseMirrorPlugins() {
    const { onHit } = this.options;

    return [
      new Plugin({
        key: new PluginKey("annotationClick"),
        props: {
          handleClick(view, pos) {
            const hits = view.state.doc
              .resolve(pos)
              .marks()
              .filter((mark) => mark.type.name === "annotation")
              .map((mark) => mark.attrs.id as string | null)
              .filter((id): id is string => Boolean(id));

            // PLAN.md §13o — a column-anchored annotation has no mark to
            // read off the position, so its ranges are asked for instead.
            // Both are collected in one handler rather than two plugins
            // racing to return true first: an overlap of one of each is
            // perfectly legal, and only a union answers "what did I just
            // click on" correctly for it.
            for (const [id, range] of getAnnotationAnchorRanges(view.state)) {
              if (pos >= range.from && pos <= range.to) hits.push(id);
            }
            // Anchored-link parts (getAnchoredLinkRanges) are deliberately
            // NOT in this union: a link-only span isn't clickable, because
            // its affordance is the ?sel= banner, not a rail card — there is
            // nothing on the page a click could jump to that the banner
            // doesn't already list (docs/ANCHORED_LINKS.md).

            const ids = Array.from(new Set(hits));
            if (ids.length === 0) return false;
            onHit(ids, pos);
            return true;
          },
        },
      }),
    ];
  },
});
