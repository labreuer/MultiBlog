import { Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";

// docs/TIPTAP.md "Indent and outdent follow the caret". One pair of commands,
// behind the toolbar's Indent/Outdent buttons and Ctrl/⌘+Shift+. and , alike,
// so the keys and the buttons can't disagree:
//
// - In a list item (the nearer of the two when lists and quotes nest), the
//   item nests under the one before it or comes out a level — sinkListItem /
//   liftListItem, what Tab and Shift-Tab already do there.
// - Anywhere else, a quote level is added or removed — wrapIn / lift, which
//   StarterKit's Mod-Shift-b (toggleBlockquote) can't do: toggling while
//   already inside a quote unwraps it rather than nesting deeper.
//
// Why these keys: > is Markdown's quote prefix, so Ctrl+> reads as "deeper"
// and Ctrl+< as "out". And no browser binds Ctrl/⌘+Shift+period or comma, so
// unlike LinkControls' Ctrl-K there is no browser default to outrun — a plain
// keymap at default priority suffices, and returning the command's own result
// is safe: a failed outdent lets the keystroke fall through to nothing rather
// than to a navigation.
//
// Known trade (shared with TipTap's own shifted-punctuation defaults, e.g.
// Superscript's Mod-.): prosemirror-keymap resolves Shift-. through the
// physical key, exact on US layouts but able to miss on layouts whose < and >
// live elsewhere (e.g. the dedicated <> key on German keyboards). The toolbar
// buttons remain the layout-independent path.

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      /** Nest the list item under the one before it, or add a quote level outside a list. */
      indent: () => ReturnType;
      /** Bring the list item out a level, or remove a quote level outside a list. */
      outdent: () => ReturnType;
    };
  }
}

/** What indenting at `$pos` acts on: the list item or the quote nearest it, and a quote where there is neither. */
export function indentTarget($pos: ResolvedPos): "listItem" | "blockquote" {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "listItem" || name === "blockquote") return name;
  }
  return "blockquote";
}

export const Indent = Extension.create({
  name: "indent",

  addCommands() {
    return {
      indent:
        () =>
        ({ state, commands }) =>
          indentTarget(state.selection.$from) === "listItem" ? commands.sinkListItem("listItem") : commands.wrapIn("blockquote"),
      outdent:
        () =>
        ({ state, commands }) =>
          indentTarget(state.selection.$from) === "listItem" ? commands.liftListItem("listItem") : commands.lift("blockquote"),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-.": () => this.editor.commands.indent(),
      "Mod-Shift-,": () => this.editor.commands.outdent(),
    };
  },
});
