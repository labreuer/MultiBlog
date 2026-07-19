"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { AuthorHighlight } from "@/lib/author-highlight-extension";
import { collectMarkAttrValues } from "@/lib/tiptap-schema";
import { useAuthorColors } from "@/lib/use-author-colors";
import AuthorHighlightStyles from "./AuthorHighlightStyles";
import styles from "./PostEditor.module.css";
import proseStyles from "@/styles/prose.module.css";
import QuoteControls from "./QuoteControls";

type Props = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  userId: string;
  userName: string;
  userColor: string;
  onEditorReady: (editor: Editor | null) => void;
};

// A thin colored bar rather than the library default's always-visible name
// label — the name still shows, but only in a tooltip on hover (see
// .collabCaretLabel in PostEditor.module.css). Never rendered for the local
// user: y-prosemirror's cursor plugin filters out the client's own
// awareness state before this is ever called.
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement("span");
  caret.classList.add(styles.collabCaret);
  caret.style.borderColor = typeof user.color === "string" ? user.color : "#999";

  const label = document.createElement("div");
  label.classList.add(styles.collabCaretLabel);
  label.style.backgroundColor = typeof user.color === "string" ? user.color : "#999";
  label.textContent = typeof user.name === "string" ? user.name : "Anonymous";

  caret.appendChild(label);
  return caret;
}

export default function CollabEditorBody({ provider, ydoc, userId, userName, userColor, onEditorReady }: Props) {
  const [authorIds, setAuthorIds] = useState<string[]>([]);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider,
        user: { id: userId, name: userName, color: userColor },
        render: renderCaret,
      }),
      AuthorHighlight.configure({ getAuthorId: () => userId }),
    ],
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => setAuthorIds(collectMarkAttrValues(e.getJSON(), "authorHighlight", "authorId")),
  });

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  const knownColors = useMemo(() => ({ [userId]: { name: userName, color: userColor } }), [userId, userName, userColor]);
  const authorColors = useAuthorColors(authorIds, knownColors);

  if (!editor) {
    return null;
  }

  return (
    <div className={styles.editorFrame}>
      <AuthorHighlightStyles colors={authorColors} />
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className={`${styles.editorContent} ${proseStyles.prose}`} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div className={styles.toolbar}>
      <button type="button" className={styles.toolbarButton} onClick={() => editor.chain().focus().toggleBold().run()}>
        Bold
      </button>
      <button type="button" className={styles.toolbarButton} onClick={() => editor.chain().focus().toggleItalic().run()}>
        Italic
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        Bullets
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        Numbered
      </button>
      <QuoteControls editor={editor} />
      <button
        type="button"
        className={styles.toolbarButton}
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        Clear formatting
      </button>
    </div>
  );
}
