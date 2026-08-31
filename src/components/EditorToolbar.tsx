"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBold,
  IconClearFormatting,
  IconH2,
  IconItalic,
  IconList,
  IconListNumbers,
} from "@tabler/icons-react";
import { tightenLines } from "@/lib/tighten-lines";
import LinkControls from "./LinkControls";
import QuoteControls from "./QuoteControls";
import styles from "./EditorChrome.module.css";

export type ToolbarTool = "undo" | "redo" | "bold" | "italic" | "link" | "h2" | "bullets" | "numbered" | "quote" | "tighten" | "clear";

// Every tool CollabEditorBody's own toolbar has always offered — its default
// so extracting this component changes nothing about the doc/post body
// editor. "tighten" (reduce space between lines, tighten-lines.ts) joined
// later, in both lists.
//
// Both editors disable StarterKit's undoRedo and get these commands from
// `Collaboration` instead — its Yjs UndoManager undoes local changes only,
// which is exactly what a button press should mean under co-editing.
export const FULL_TOOLS: ToolbarTool[] = ["undo", "redo", "bold", "italic", "link", "h2", "bullets", "numbered", "quote", "tighten", "clear"];

// PLAN.md §13e — the reduced set an annotation's editor offers: no headings,
// no numbered lists, both heavier than a margin note needs. "tighten" stays:
// cramped margin cards are where tight spacing matters most.
export const ANNOTATION_TOOLS: ToolbarTool[] = ["undo", "redo", "bold", "italic", "link", "bullets", "quote", "tighten", "clear"];

// match Tabler style
function IconTightenLines({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5h8" />
      <path d="M3 12h8" />
      <path d="M3 19h8" />
      <path d="M18 4v6m-3 -3l3 3l3 -3" />
      <path d="M18 20v-6m-3 3l3 -3l3 3" />
    </svg>
  );
}

// Extracted out of CollabEditorBody so an annotation's editor (AnnotationBody,
// PLAN.md §13e) can reuse it with a smaller `tools` list instead of forking
// the markup — the buttons themselves don't know or care which editor they're
// attached to, only the `editor` instance passed in.
export default function EditorToolbar({
  editor,
  disabled,
  tools = FULL_TOOLS,
}: {
  editor: Editor;
  disabled?: boolean;
  tools?: ToolbarTool[];
}) {
  // The buttons whose enabled-ness depends on editor state: tightening
  // acts on the selection, so a caret alone leaves it inert (its chosen
  // no-selection behavior — tighten-lines.ts), and undo/redo follow their
  // stacks (`can().undo()` is a dry run of Collaboration's undo command,
  // which is a stack-length check — cheap enough for a per-transaction
  // selector). useEditorState deep-equals the selected object, so this
  // component re-renders only when a boolean flips, not per keystroke.
  const { selectionEmpty, canUndo, canRedo } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      selectionEmpty: e.state.selection.empty,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  return (
    <div className={styles.toolbar}>
      {tools.includes("undo") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled || !canUndo}
          aria-label="Undo"
          title="Undo"
          onClick={() => editor.chain().focus().undo().run()}
        >
          <IconArrowBackUp size={18} />
        </button>
      )}
      {tools.includes("redo") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled || !canRedo}
          aria-label="Redo"
          title="Redo"
          onClick={() => editor.chain().focus().redo().run()}
        >
          <IconArrowForwardUp size={18} />
        </button>
      )}
      {tools.includes("bold") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          aria-label="Bold"
          title="Bold"
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <IconBold size={18} />
        </button>
      )}
      {tools.includes("italic") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          aria-label="Italic"
          title="Italic"
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <IconItalic size={18} />
        </button>
      )}
      {tools.includes("link") && <LinkControls editor={editor} disabled={disabled} />}
      {tools.includes("h2") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          aria-label="Heading 2"
          title="Heading 2"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <IconH2 size={18} />
        </button>
      )}
      {tools.includes("bullets") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          aria-label="Bullet list"
          title="Bullet list"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <IconList size={18} />
        </button>
      )}
      {tools.includes("numbered") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          aria-label="Numbered list"
          title="Numbered list"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <IconListNumbers size={18} />
        </button>
      )}
      {tools.includes("quote") && <QuoteControls editor={editor} disabled={disabled} />}
      {tools.includes("tighten") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled || selectionEmpty}
          aria-label="Reduce space between lines"
          title="Reduce space between lines"
          onClick={() => tightenLines(editor)}
        >
          <IconTightenLines size={18} />
        </button>
      )}
      {tools.includes("clear") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          aria-label="Clear formatting"
          title="Clear formatting"
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <IconClearFormatting size={18} />
        </button>
      )}
    </div>
  );
}
