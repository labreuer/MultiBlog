"use client";

import { useEffect } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";

const CARET_COLORS = ["#f783ac", "#845ef7", "#339af0", "#20c997", "#fab005", "#ff6b6b"];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return CARET_COLORS[hash % CARET_COLORS.length];
}

type Props = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  userName: string;
  onEditorReady: (editor: Editor | null) => void;
};

export default function CollabEditorBody({ provider, ydoc, userName, onEditorReady }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { name: userName, color: colorFor(userName) } }),
    ],
    immediatelyRender: false,
  });

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  if (!editor) {
    return null;
  }

  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 4 }}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} style={{ minHeight: 300, padding: 12 }} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div style={{ display: "flex", gap: 4, padding: 8, borderBottom: "1px solid #ccc" }}>
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}>
        Bold
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}>
        Italic
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        H2
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        Bullets
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        Numbered
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        Quote
      </button>
    </div>
  );
}
