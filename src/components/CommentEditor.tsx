"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { UndoRedo } from "@tiptap/extensions";
import { ListKeymap } from "@tiptap/extension-list";
import { commentContentExtensions } from "@/lib/tiptap-schema";
import { VirtualKeyboardEnter } from "@/lib/virtual-keyboard-enter-extension";
import { QuoteDepthShortcuts } from "@/lib/quote-depth-shortcuts-extension";
import EditorToolbar, { type ToolbarTool } from "./EditorToolbar";
import proseStyles from "@/styles/prose.module.css";
import bodyStyles from "./CommentBody.module.css";
import styles from "./CommentEditor.module.css";

// PLAN.md §23h — the rich comment composer's reduced tool set. No headings
// (not in the schema), no tighten (a comment is short); undo/redo come from
// UndoRedo below rather than from Collaboration, since there is no ydoc here.
export const COMMENT_TOOLS: ToolbarTool[] = ["undo", "redo", "bold", "italic", "link", "bullets", "numbered", "quote", "clear"];

type Props = {
  /** Mounted once with this; an external replacement remounts via `key`. */
  initialContent: JSONContent | null;
  /** Null when the editor is empty, so the caller has one emptiness check for both modes. */
  onChange: (json: JSONContent | null) => void;
  ariaLabel: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The live instance, for the quote gesture's insertContent; null on unmount. */
  onEditorReady?: (editor: Editor | null) => void;
};

// PLAN.md §23h — AnnotationBody's shape minus every collaboration piece: no
// Collaboration, no CollaborationCaret, no provider, no AuthorHighlight. The
// extension list is exactly commentContentExtensions — the schema the server
// validates against — plus editor-only behaviour that contributes no node or
// mark (undo history, list keys, the virtual-keyboard Enter, quote-depth
// shortcuts), so nothing typeable here is refused on submit.
export default function CommentEditor({
  initialContent,
  onChange,
  ariaLabel,
  disabled = false,
  autoFocus = false,
  onEditorReady,
}: Props) {
  // A ref rather than a captured closure: useEditor's options are read once
  // at construction, and the parent's onChange is recreated per render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    extensions: [...commentContentExtensions, UndoRedo, ListKeymap, VirtualKeyboardEnter, QuoteDepthShortcuts],
    content: initialContent ?? undefined,
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox" } },
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => onChangeRef.current(e.isEmpty ? null : e.getJSON()),
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  if (!editor) {
    return <div className={styles.placeholder} aria-hidden="true" />;
  }

  return (
    <div className={styles.frame}>
      <EditorToolbar editor={editor} disabled={disabled} tools={COMMENT_TOOLS} />
      <EditorContent editor={editor} className={`${styles.content} ${proseStyles.prose} ${bodyStyles.body}`} />
    </div>
  );
}
