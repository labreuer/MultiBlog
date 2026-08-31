import { Extension, isNodeSelection } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Keeps a non-empty selection painted while the editor is blurred. A
// document has one DOM selection, and a popover's input taking focus takes
// it — ProseMirror's state.selection is untouched, only the paint goes.
// This decorates state.selection with class "selection" (prose.module.css)
// whenever the editor is editable, blurred and has a real text selection;
// the FocusEvents core extension dispatches a transaction on every
// focus/blur, which is what re-evaluates it.
//
// A decoration and nothing else — not @tiptap/extensions' stock
// `Selection`, which paints the same decoration but also clears the DOM
// selection on blur and re-applies the state selection to the DOM a frame
// after focus. Neither write is needed for the paint (a popover's input
// takes the DOM selection anyway, and ProseMirror restores its own on
// focus), and DOM-selection writes from a plugin are one more thing to
// reason about under the doc editor's selection-driven annotate widget.
// Same shape as pending-annotation-extension.ts: view-only, never touches
// the document.
//
// One consequence of any decoration that leaves on focus, this one
// included: the focus transaction re-renders the decorated text, and
// ProseMirror then re-asserts its state selection over the DOM's. A real
// gesture focuses first and selects second, so nothing is lost; a script
// that sets a DOM range *before* focusing the editor has that range
// replaced by the stale one. That is why e2e/fixtures.ts' selectTextIn
// focuses the editor before selecting (it broke margin-rail-widths.spec's
// annotate-marker case when it didn't).
export const BlurredSelection = Extension.create({
  name: "blurredSelection",

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey("blurredSelection"),
        props: {
          decorations(state) {
            const { selection } = state;
            if (selection.empty || isNodeSelection(selection) || !editor.isEditable || editor.isFocused) return null;
            return DecorationSet.create(state.doc, [
              Decoration.inline(selection.from, selection.to, { class: "selection" }),
            ]);
          },
        },
      }),
    ];
  },
});
