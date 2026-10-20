import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

// The iPad keyboard's B/I/U buttons (and the "Format" item in iOS's
// selection callout) don't press a key. WebKit runs its own ToggleBold /
// ToggleItalic / ToggleUnderline editing command, announced as a cancelable
// `beforeinput` whose inputType is formatBold, formatItalic or
// formatUnderline. ProseMirror's beforeinput handler ignores those, so the
// browser's default edit goes ahead and is lost: on a caret it only sets
// WebKit's own typing style, while ProseMirror inserts the next typed text
// with the marks *its* state says (so the button does nothing), and on a
// range it rewrites the DOM behind ProseMirror's back and leaves the
// result to be re-parsed. This cancels the browser's edit and runs the same
// toggleMark Mod-B/I/U run, so a caret gets stored marks and a range gets
// one addMark/removeMark transaction, through the plugins every other edit
// passes through (Collaboration, AuthorHighlight).
//
// A mark the editor's schema lacks (underline in the comment and blurb
// schemas, strike in the blurb's) is cancelled all the same, so the button
// does nothing at all rather than leaving the browser's formatting to be
// redrawn away. formatStrikeThrough is listed though iOS sends no such
// event, because desktop browsers' format commands can.
//
// A hardware keyboard's Cmd-B never gets here: TipTap's keymap handles the
// keydown and prevents its default, and no beforeinput follows. Only a
// shortcut the keymap passes up (Cmd-U in a schema with no underline) falls
// through to the browser's command, and lands here as a no-op.
//
// Registered beside the other editor-only extensions wherever an editor's
// schema has marks — CollabEditorBody, AnnotationBody, CommentEditor and
// ContributorPanel's blurb — never in a schema list, since it adds
// behavior and no node or mark. The title editor is left out: its schema
// has no marks to toggle.
const MARK_FOR_INPUT_TYPE: Record<string, string> = {
  formatBold: "bold",
  formatItalic: "italic",
  formatUnderline: "underline",
  formatStrikeThrough: "strike",
};

export const FormatInputEvents = Extension.create({
  name: "formatInputEvents",

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey("formatInputEvents"),
        props: {
          handleDOMEvents: {
            beforeinput: (view, event) => {
              const markName = MARK_FOR_INPUT_TYPE[event.inputType];
              if (!markName) return false;
              event.preventDefault();
              if (view.state.schema.marks[markName]) editor.commands.toggleMark(markName);
              return true;
            },
          },
        },
      }),
    ];
  },
});
