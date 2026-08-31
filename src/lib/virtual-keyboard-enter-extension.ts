import { Extension } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { ensureVirtualKeyboardTracking, virtualKeyboardVisible } from "./virtual-keyboard";

// While the virtual keyboard is on screen ("virtual-keyboard mode"), the
// block keys behave like a phone messenger's, and the two modes are kept
// mutually convertible so text authored in one edits naturally in the
// other:
//
// - Enter inserts the hard break Shift-Enter inserts — because a virtual
//   keyboard has no Shift-Enter, so the soft break is otherwise
//   unreachable on a phone.
// - Enter with a hard break already right before the caret *upgrades*:
//   the break is deleted and the paragraph splits for real, so double
//   Enter is the paragraph gesture (the Slack/WhatsApp convention).
//   Deliberately loose — any break before the caret counts, whoever typed
//   it and whenever — which makes the rule stateless and predictable, at
//   the cost that two *adjacent* hard breaks cannot be typed with Enter
//   at all in this mode (Enter-space-Enter leaves a space-bearing line as
//   the nearest approximation; a hardware keyboard's Shift-Enter types
//   them directly).
// - Backspace at the start of a non-empty textblock joins into the
//   previous non-empty textblock *and leaves a hard break at the seam* —
//   the paragraph boundary downgrades rather than vanishing, and a second
//   Backspace (stock, the break is just a node before the caret) finishes
//   the merge. Two Backspaces undo two Enters.
// - Inside a list item, none of this: Enter keeps splitListItem and
//   Backspace keeps its lift/join semantics, stock in both modes.
//
// With a hardware keyboard attached — the one that *has* Shift-Enter —
// nothing docks, the mode is off, and every key keeps its stock behavior.
// How visibility is measured, the standard APIs weighed, and the
// dev/test override (window.__multiblogSetVirtualKeyboard):
// src/lib/virtual-keyboard.ts.
//
// Keymap-level on purpose, not per-editor wiring: registered beside the
// other shared extensions in both live body editors (CollabEditorBody,
// AnnotationBody). The title and blurb editors are left out — their
// schemas have no hardBreak node and no HardBreak extension (so no
// setHardBreak command to call), and Enter/Shift-Enter are both already
// no-ops there.

function withinListItem($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") return true;
  }
  return false;
}

export const VirtualKeyboardEnter = Extension.create({
  name: "virtualKeyboardEnter",

  // Above the default 100, which is what core Keymap's Enter/Backspace and
  // ListItem's Enter (splitListItem) all run at. Same-priority keymaps run
  // in *reverse registration order* (ExtensionManager reverses the list
  // before its stable sort), so at 100 this extension's place in the chain
  // would depend on where the useEditor array happens to list it; 101 pins
  // it ahead of every stock handler by number instead of by position.
  // DocRefMenu's Enter still wins over this: its Suggestion plugin is
  // registered prepended, ahead of all keymap plugins outright.
  priority: 101,

  onCreate() {
    // Start watching before the first question — the viewport resize that
    // decides the answer precedes the Enter that asks it.
    ensureVirtualKeyboardTracking();
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!virtualKeyboardVisible()) return false;
        // Mid-composition, Enter belongs to the IME (it confirms the
        // candidate) — stand down, the same way DocRefMenu's key handler
        // does. Same for Backspace below (it deletes the candidate's last
        // character).
        if (this.editor.view.composing) return false;
        const { $from, empty } = this.editor.state.selection;
        // A list item's Enter is splitListItem, kept stock in this mode
        // too — remapping it would leave list structure unreachable from
        // a phone.
        if (withinListItem($from)) return false;
        if (empty && $from.nodeBefore?.type.name === "hardBreak") {
          // The upgrade: one transaction, so undo and the Yjs sync see a
          // single atomic "paragraph split", never a deleted break with a
          // split arriving separately.
          return this.editor.chain().deleteRange({ from: $from.pos - 1, to: $from.pos }).splitBlock().run();
        }
        // False wherever hardBreak cannot go (a code block), which falls
        // through to the stock Enter chain — so code blocks keep their
        // newline and triple-Enter exit under a virtual keyboard too.
        return this.editor.commands.setHardBreak();
      },
      Backspace: () => {
        if (!virtualKeyboardVisible()) return false;
        if (this.editor.view.composing) return false;
        const { $from, empty } = this.editor.state.selection;
        // Only the caret-at-block-start case is ours; a selection, or a
        // caret mid-text, deletes stock.
        if (!empty || $from.parentOffset !== 0) return false;
        // List items keep their stock lift/join — same reasoning as Enter.
        if (withinListItem($from)) return false;
        // An empty block dies the stock way (nothing to separate), and a
        // non-textblock start (doc start included) is stock territory.
        if (!$from.parent.isTextblock || $from.parent.content.size === 0) return false;
        const index = $from.index(-1);
        if (index === 0) return false;
        const prev = $from.node(-1).child(index - 1);
        // The seam only gets a break when both sides bring text, and never
        // into a code block (hardBreak can't live there; joining is
        // stock's call).
        if (!prev.isTextblock || prev.content.size === 0 || prev.type.spec.code) return false;
        // joinBackward leaves the caret at the seam; setHardBreak puts the
        // break there and the caret after it — visually the caret barely
        // moves, and the next Backspace faces the break itself.
        return this.editor.chain().joinBackward().setHardBreak().run();
      },
    };
  },
});
