import { Mark, mergeAttributes } from "@tiptap/core";

// PLAN.md §23f — the inline quotation mark: `<q>` around a span of a comment
// body that quotes a passage of something else, carrying nothing but the id
// of the `comment_quote_anchor` row that says what. The quoted words are real
// content in the body (§23f's three reasons); the row is the citation.
//
// Self-excluding, which is ProseMirror's default for a mark and is stated
// here because the `annotation` mark deliberately sets `excludes: ""` to
// allow overlaps: two quotations of different things over one span mean
// nothing, so the default is the right one and is not to be copied from
// there.
//
// No `parseMarkdown`: the Markdown box never produces this mark. A quoted
// run typed there is found by the matcher (§23n) after the parse, and it is
// the matcher that decides whether "…" is a citation or just quotation marks.
// `renderMarkdown` is the other direction — the edit box shows the stored
// body as Markdown, and a quotation reads back as straight double quotes,
// which the matcher re-finds on save.
export const Quote = Mark.create({
  name: "quote",

  addAttributes() {
    return {
      anchorId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-anchor-id"),
        renderHTML: (attributes) => (attributes.anchorId ? { "data-anchor-id": attributes.anchorId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "q" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["q", mergeAttributes(HTMLAttributes), 0];
  },

  renderMarkdown: (_node, helpers) => `"${helpers.renderChildren(_node.content ?? [])}"`,
});
