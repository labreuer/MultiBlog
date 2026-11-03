import { Extension } from "@tiptap/core";
import type { NodeType, ResolvedPos } from "@tiptap/pm/model";
import type { Command, Selection, Transaction } from "@tiptap/pm/state";
import { sinkListItem } from "@tiptap/pm/schema-list";

// docs/TIPTAP.md "Indent and outdent follow the caret". One pair of commands,
// behind the toolbar's Indent/Outdent buttons and Ctrl/⌘+Shift+. and , alike,
// so the keys and the buttons can't disagree:
//
// - In a list item (the nearer of the two when lists and quotes nest), the
//   item nests under the one before it or comes out a level — sinkListItem /
//   liftListItem, what Shift-Tab already does there. Tab is bound here too,
//   so it indents the way the button does (below). A new level under a
//   numbered list starts as bullets (sinkListItemBulletFirst).
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
      /** Nest the list item under the one before it, a new level under a numbered list as bullets; false outside a list item. */
      indentListItem: () => ReturnType;
      /** Nest the list item under the one before it, or add a quote level outside a list. */
      indent: () => ReturnType;
      /** Bring the list item out a level, or remove a quote level outside a list. */
      outdent: () => ReturnType;
    };
  }
}

// The list a sink acts on, found as prosemirror-schema-list's sinkListItem
// finds it: the innermost node whose children are list items, around the
// whole selection.
function listRange(selection: Selection, itemType: NodeType) {
  return selection.$from.blockRange(selection.$to, (node) => node.childCount > 0 && node.firstChild!.type === itemType);
}

// The new level a sink just made: the list now holding the moved items. A
// numbered one becomes a bullet list, and joins a bullet list directly before
// it — the item above's own nested bullets — rather than sitting beside it.
function bulletNewLevel(tr: Transaction, itemType: NodeType) {
  const range = listRange(tr.selection, itemType);
  const bulletList = tr.doc.type.schema.nodes.bulletList;
  if (!range || !bulletList || range.depth === 0) return;
  const pos = range.$from.before(range.depth);
  tr.setNodeMarkup(pos, bulletList, null);
  if (tr.doc.resolve(pos).nodeBefore?.type === bulletList) tr.join(pos);
}

/**
 * sinkListItem, with one difference: indenting out of a numbered list starts
 * the new level as bullets. An item joining a numbered level already under
 * the one before it stays numbered, in that level's style, as sinkListItem
 * leaves it — the default is for a level that doesn't exist yet.
 */
export function sinkListItemBulletFirst(itemType: NodeType): Command {
  const sink = sinkListItem(itemType);
  return (state, dispatch) => {
    const range = listRange(state.selection, itemType);
    const before = range && range.startIndex > 0 ? range.parent.child(range.startIndex - 1) : null;
    // sinkListItem joins the level before only when it is the list's own type.
    const makesNumberedLevel =
      range?.parent.type.name === "orderedList" && !!before && before.lastChild?.type !== range.parent.type;
    if (!makesNumberedLevel || !dispatch) return sink(state, dispatch);
    return sink(state, (tr) => {
      bulletNewLevel(tr, itemType);
      dispatch(tr);
    });
  };
}

/** What indenting at `$pos` acts on: the list item or the quote nearest it, and a quote where there is neither. */
export function indentTarget($pos: ResolvedPos): "listItem" | "blockquote" {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "listItem" || name === "blockquote") return name;
  }
  return "blockquote";
}

function inTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.spec.tableRole === "table") return true;
  }
  return false;
}

export const Indent = Extension.create({
  name: "indent",
  // Ahead of ListItem's own Tab (sinkListItem, at the default 100), so Tab in
  // a list indents as the button does. Outside a list item this Tab declines
  // and the key goes on as before. So it does anywhere in a table: Table's
  // Tab (next cell, or a new row from the last) ran before ListItem's there,
  // being registered later at the same priority, so a list in a cell never
  // had Tab, and the button is its way to indent.
  priority: 101,

  addCommands() {
    return {
      indentListItem:
        () =>
        ({ state, dispatch }) => {
          const itemType = state.schema.nodes.listItem;
          if (!itemType || indentTarget(state.selection.$from) !== "listItem") return false;
          return sinkListItemBulletFirst(itemType)(state, dispatch);
        },
      indent:
        () =>
        ({ state, commands }) =>
          indentTarget(state.selection.$from) === "listItem" ? commands.indentListItem() : commands.wrapIn("blockquote"),
      outdent:
        () =>
        ({ state, commands }) =>
          indentTarget(state.selection.$from) === "listItem" ? commands.liftListItem("listItem") : commands.lift("blockquote"),
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => !inTable(this.editor.state.selection.$from) && this.editor.commands.indentListItem(),
      "Mod-Shift-.": () => this.editor.commands.indent(),
      "Mod-Shift-,": () => this.editor.commands.outdent(),
    };
  },
});
