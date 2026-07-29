import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";

export type PendingRange = { from: number; to: number; color: string } | null;

// PLAN.md §13f — the selected-but-not-yet-annotated range while composing
// inline. A decoration, not a mark: it isn't content, never syncs, and never
// touches the doc's ydoc, unlike the `annotation` mark itself
// (annotation-extension.ts) — the browser's own native selection highlight
// disappears the moment focus moves into the popup's live editor, and this
// is what keeps the source text visibly marked while that's true.
export const pendingAnnotationKey = new PluginKey<PendingRange>("pendingAnnotation");

// Dispatched by LiveDocBody whenever the pending range changes (a fresh
// selection, or a re-resolution after a live update moved the text) — the
// meta-tagged transaction is what `apply` below reads instead of
// recomputing state from the document itself.
export function setPendingAnnotation(view: EditorView, range: PendingRange): void {
  view.dispatch(view.state.tr.setMeta(pendingAnnotationKey, range));
}

export const PendingAnnotation = Extension.create({
  name: "pendingAnnotation",

  addProseMirrorPlugins() {
    return [
      new Plugin<PendingRange>({
        key: pendingAnnotationKey,
        state: {
          init: () => null,
          apply(tr: Transaction, value: PendingRange) {
            const meta = tr.getMeta(pendingAnnotationKey);
            if (meta !== undefined) {
              return meta;
            }
            // A normal (non-setContent-replacing-everything) edit — map the
            // range through it so the highlight tracks its text. This is a
            // best-effort convenience only: LiveDocBody's explicit
            // textBetween re-verification (§13f) is what actually catches
            // the case a remote update's full-document setContent call
            // defeats this mapping.
            if (value && tr.docChanged) {
              const from = tr.mapping.map(value.from, -1);
              const to = tr.mapping.map(value.to, 1);
              return to > from ? { ...value, from, to } : null;
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const range = pendingAnnotationKey.getState(state);
            if (!range || range.to <= range.from || range.to > state.doc.content.size) {
              return null;
            }
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, {
                class: "pending-annotation",
                style: `--thread-color:${range.color}`,
              }),
            ]);
          },
        },
      }),
    ];
  },
});
