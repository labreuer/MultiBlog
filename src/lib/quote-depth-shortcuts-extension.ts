import { Extension } from "@tiptap/core";

// Ctrl/⌘+Shift+. ("Ctrl+>") wraps the selection one blockquote level
// deeper; Ctrl/⌘+Shift+, ("Ctrl+<") lifts it one level out — the same
// wrapIn/lift pair as QuoteControls' dropdown items, which StarterKit's
// Mod-Shift-b (toggleBlockquote) can't reach: toggling while already
// inside a quote unwraps it rather than nesting deeper.
//
// Why these keys: > is Markdown's quote prefix, so Ctrl+> reads as "quote
// deeper" and Ctrl+< as "quote out". And no browser binds Ctrl/⌘+Shift+
// period or comma, so unlike LinkControls' Ctrl-K there is no browser
// default to outrun — a plain keymap at default priority suffices, and
// returning the command's own result is safe: a failed lift lets the
// keystroke fall through to nothing rather than to a navigation.
//
// Known trade (shared with TipTap's own shifted-punctuation defaults,
// e.g. Superscript's Mod-.): prosemirror-keymap resolves Shift-. through
// the physical key, exact on US layouts but able to miss on layouts whose
// < and > live elsewhere (e.g. the dedicated <> key on German keyboards).
// The toolbar dropdown remains the layout-independent path.
export const QuoteDepthShortcuts = Extension.create({
  name: "quoteDepthShortcuts",

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-.": () => this.editor.commands.wrapIn("blockquote"),
      "Mod-Shift-,": () => this.editor.commands.lift("blockquote"),
    };
  },
});
