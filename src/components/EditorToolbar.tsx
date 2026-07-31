"use client";

import type { Editor } from "@tiptap/react";
import QuoteControls from "./QuoteControls";
import styles from "./EditorChrome.module.css";

export type ToolbarTool = "bold" | "italic" | "h2" | "bullets" | "numbered" | "quote" | "clear";

// Every tool CollabEditorBody's own toolbar has always offered — its default
// so extracting this component changes nothing about the doc/post body editor.
export const FULL_TOOLS: ToolbarTool[] = ["bold", "italic", "h2", "bullets", "numbered", "quote", "clear"];

// PLAN.md §13e — the reduced set an annotation's editor offers: no headings,
// no numbered lists, both heavier than a margin note needs.
export const ANNOTATION_TOOLS: ToolbarTool[] = ["bold", "italic", "bullets", "quote", "clear"];

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
  return (
    <div className={styles.toolbar}>
      {tools.includes("bold") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          Bold
        </button>
      )}
      {tools.includes("italic") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          Italic
        </button>
      )}
      {tools.includes("h2") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
      )}
      {tools.includes("bullets") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          Bullets
        </button>
      )}
      {tools.includes("numbered") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          Numbered
        </button>
      )}
      {tools.includes("quote") && <QuoteControls editor={editor} disabled={disabled} />}
      {tools.includes("clear") && (
        <button
          type="button"
          className={styles.toolbarButton}
          disabled={disabled}
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          Clear formatting
        </button>
      )}
    </div>
  );
}
