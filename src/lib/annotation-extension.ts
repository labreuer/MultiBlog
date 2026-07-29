import { Mark, mergeAttributes } from "@tiptap/core";

// A doc annotation's anchor (PLAN.md §12i) — content, not a decoration or a
// stored position. `excludes: ""` overrides ProseMirror's default of a mark
// type excluding its own type, which would make a second annotation over
// overlapping text *replace* the first instead of coexisting with it;
// several instances with different `id` attrs can sit on the same text, and
// ProseMirror splits the run into segments carrying the right subsets on its
// own — no `data-thread-ids`-plural handling needed, since that exists for
// overlapping *decorations* (quote-highlight-extension.ts), which this isn't.
//
// Applied only server-side, through the collab server (server/ydoc-hooks.ts's
// handleApplyAnnotationMark) — never by a client transaction — so this
// extension carries no ProseMirror plugin of its own, unlike AuthorHighlight.
export const Annotation = Mark.create({
  name: "annotation",
  excludes: "",
  // Otherwise CollabEditorBody's "Clear formatting" toolbar button
  // (unsetAllMarks) strips the mark right along with real formatting —
  // the anchor is content, not styling (§12i above), and isn't the user's
  // to remove via a formatting shortcut.
  clearable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-annotation-id"),
        renderHTML: (attributes) => (attributes.id ? { "data-annotation-id": attributes.id } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-annotation-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "annotation-highlight" }), 0];
  },
});
