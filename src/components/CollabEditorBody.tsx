"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { AuthorHighlight } from "@/lib/author-highlight-extension";
import { collectAuthorHighlightStats } from "@/lib/tiptap-schema";
import { useAuthorColors } from "@/lib/use-author-colors";
import { perfMeasure } from "@/lib/perf-monitor";
import AuthorHighlightStyles from "./AuthorHighlightStyles";
import styles from "./PostEditor.module.css";
import proseStyles from "@/styles/prose.module.css";
import QuoteControls from "./QuoteControls";

// See PERFORMANCE.md — walking the whole document for author-mark stats is
// O(document size); debouncing keeps it off the per-keystroke path.
const AUTHOR_STATS_DEBOUNCE_MS = 400;

export type AuthorStat = { authorId: string; chars: number; name: string; color: string };

type Props = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  userId: string;
  userName: string;
  userColor: string;
  editable?: boolean;
  onEditorReady: (editor: Editor | null) => void;
  onAuthorStats?: (stats: AuthorStat[]) => void;
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

export default function CollabEditorBody({
  provider,
  ydoc,
  userId,
  userName,
  userColor,
  editable = true,
  onEditorReady,
  onAuthorStats,
}: Props) {
  const [authorIds, setAuthorIds] = useState<string[]>([]);
  const [authorCharCounts, setAuthorCharCounts] = useState<Record<string, number>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    onUpdate: ({ editor: e }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const { authorIds: ids, charsByAuthor } = perfMeasure("author-highlight walk", () =>
          collectAuthorHighlightStats(e.state.doc, "authorHighlight", "authorId"),
        );
        setAuthorIds(ids);
        setAuthorCharCounts(charsByAuthor);
      }, AUTHOR_STATS_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  // useEditor's `editable` option is only read at construction time, not
  // reactive — toggling it later (e.g. after a soft delete) requires calling
  // setEditable directly.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const knownColors = useMemo(() => ({ [userId]: { name: userName, color: userColor } }), [userId, userName, userColor]);
  const authorColors = useAuthorColors(authorIds, knownColors);

  useEffect(() => {
    if (!onAuthorStats) return;
    onAuthorStats(
      Object.entries(authorCharCounts).map(([authorId, chars]) => ({
        authorId,
        chars,
        name: authorColors[authorId]?.name ?? authorId,
        color: authorColors[authorId]?.color ?? "#999",
      })),
    );
  }, [authorCharCounts, authorColors, onAuthorStats]);

  if (!editor) {
    return null;
  }

  return (
    <div className={styles.editorFrame}>
      <AuthorHighlightStyles colors={authorColors} />
      <Toolbar editor={editor} disabled={!editable} />
      <EditorContent editor={editor} className={`${styles.editorContent} ${proseStyles.prose}`} />
    </div>
  );
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        Bold
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        Italic
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        Bullets
      </button>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        Numbered
      </button>
      <QuoteControls editor={editor} disabled={disabled} />
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        Clear formatting
      </button>
    </div>
  );
}
