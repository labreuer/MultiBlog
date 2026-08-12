import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export type AnnotationClickOptions = {
  // Fired with every distinct annotation id whose mark covers the clicked
  // position (more than one only when annotations overlap — annotation-
  // extension.ts's `excludes: ""` allows that). Never fired for a
  // mousedown/mouseup that land at different positions, so dragging a new
  // selection that starts inside already-annotated text still falls through
  // to the normal onSelectionUpdate path instead of jumping away.
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
            const ids = Array.from(
              new Set(
                view.state.doc
                  .resolve(pos)
                  .marks()
                  .filter((mark) => mark.type.name === "annotation")
                  .map((mark) => mark.attrs.id as string | null)
                  .filter((id): id is string => Boolean(id)),
              ),
            );
            if (ids.length === 0) return false;
            onHit(ids, pos);
            return true;
          },
        },
      }),
    ];
  },
});
