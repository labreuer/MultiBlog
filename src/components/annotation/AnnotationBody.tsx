"use client";

import { useEffect, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { AuthorHighlight } from "@/lib/author-highlight-extension";
import EditorToolbar, { ANNOTATION_TOOLS } from "../EditorToolbar";
import proseStyles from "@/styles/prose.module.css";
import styles from "./AnnotationBody.module.css";

const TOOLBAR_STORAGE_KEY = "multiblog.annotationToolbar";

type Props = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  userId: string;
  userName: string;
  userColor: string;
  editable?: boolean;
  onEditorReady?: (editor: Editor | null) => void;
};

// PLAN.md §13e — an annotation's own live editor. Deliberately close to
// CollabEditorBody's shape (StarterKit sans undo/redo, Collaboration bound
// to this ydoc, CollaborationCaret for co-authoring presence,
// AuthorHighlight for the per-author color-coding §13h gates) but with the
// `annotation` mark left out — matches annotationContentExtensions
// (tiptap-schema.ts): an annotation body can't itself carry an anchor onto
// another annotation. The toolbar defaults to hidden, per-browser via
// localStorage, and offers ANNOTATION_TOOLS' reduced set rather than
// CollabEditorBody's full one — a margin note doesn't need headings or
// numbered lists.
export default function AnnotationBody({ provider, ydoc, userId, userName, userColor, editable = true, onEditorReady }: Props) {
  const [toolbarVisible, setToolbarVisible] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from localStorage (an external system)
    setToolbarVisible(window.localStorage.getItem(TOOLBAR_STORAGE_KEY) === "1");
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { id: userId, name: userName, color: userColor } }),
      AuthorHighlight.configure({ getAuthorId: () => userId }),
    ],
    editorProps: { attributes: { "aria-label": "Annotation body", role: "textbox" } },
    immediatelyRender: false,
  });

  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  function toggleToolbar() {
    setToolbarVisible((visible) => {
      const next = !visible;
      window.localStorage.setItem(TOOLBAR_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  if (!editor) {
    return null;
  }

  return (
    <div className={styles.frame}>
      {toolbarVisible && <EditorToolbar editor={editor} disabled={!editable} tools={ANNOTATION_TOOLS} />}
      <EditorContent editor={editor} className={`${styles.content} ${proseStyles.prose}`} />
      {editable && (
        <button type="button" onClick={toggleToolbar} className={styles.toolbarToggle}>
          {toolbarVisible ? "Hide formatting" : "Aa Formatting"}
        </button>
      )}
    </div>
  );
}
