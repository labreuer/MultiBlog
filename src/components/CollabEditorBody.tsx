"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { AuthorHighlight } from "@/lib/author-highlight-extension";
import { Annotation } from "@/lib/annotation-extension";
import { collectAuthorHighlightStats } from "@/lib/tiptap-schema";
import { useAuthorColors } from "@/lib/use-author-colors";
import { NEUTRAL_THREAD_COLOR } from "@/lib/author-colors";
import { perfMeasure } from "@/lib/perf-monitor";
import AuthorHighlightStyles from "./AuthorHighlightStyles";
import EditorToolbar from "./EditorToolbar";
import { EDITOR_SCROLL_ATTRIBUTE } from "./editor-scroll";
import styles from "./EditorChrome.module.css";
import proseStyles from "@/styles/prose.module.css";

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
  // Overrides the default accessible name — needed on /side-by-side (PLAN.md
  // §14f), which can mount two body editors on one page and would otherwise
  // break e2e's strict-mode `getByRole("textbox", { name: "Post body" })`
  // locator. Read only at useEditor construction, same as editorProps
  // generally, so a column's aria-label is fixed at mount rather than
  // reactive.
  ariaLabel?: string;
  // Matches the read column's own suppression — PLAN.md §14f. The write column keeps
  // the `annotation` mark registered (dropping it would strip existing
  // anchors the moment anyone typed) but paints over its highlight the same
  // way the read column does.
  suppressAnnotations?: boolean;
};

// A thin colored bar rather than the library default's always-visible name
// label — the name still shows, but only in a tooltip on hover (see
// .collabCaretLabel in EditorChrome.module.css). Never rendered for the local
// user: y-prosemirror's cursor plugin filters out the client's own
// awareness state before this is ever called.
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement("span");
  caret.classList.add(styles.collabCaret);
  caret.style.borderColor = typeof user.color === "string" ? user.color : NEUTRAL_THREAD_COLOR;

  const label = document.createElement("div");
  label.classList.add(styles.collabCaretLabel);
  label.style.backgroundColor = typeof user.color === "string" ? user.color : NEUTRAL_THREAD_COLOR;
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
  ariaLabel = "Post body",
  suppressAnnotations = false,
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
      // Registers the mark type so a doc's annotation marks sync/render
      // correctly here too (PLAN.md §12i) — posts never get one applied,
      // and an unused mark type in the schema costs nothing.
      Annotation,
    ],
    // Matches the title field's own aria-label/role. Two contenteditables
    // share this page, and without distinct accessible names the only thing
    // telling them apart is DOM order — which is what the e2e suite would
    // otherwise have to key off (see CLAUDE.md's `.tiptap` ordering note).
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox" } },
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
        color: authorColors[authorId]?.color ?? NEUTRAL_THREAD_COLOR,
      })),
    );
  }, [authorCharCounts, authorColors, onAuthorStats]);

  if (!editor) {
    return null;
  }

  return (
    <div className={styles.editorFrame}>
      <AuthorHighlightStyles colors={authorColors} />
      <EditorToolbar editor={editor} disabled={!editable} />
      {/* The attribute marks this as *the* scrolling box for the body, which
          the doc editor's annotation rail (PLAN.md §18c) needs in order to
          know which band of text is on screen — the page doesn't scroll here,
          this does. Harmless on the embedders that have no rail. */}
      <EditorContent
        editor={editor}
        {...{ [EDITOR_SCROLL_ATTRIBUTE]: "" }}
        className={`${styles.editorContent} ${proseStyles.prose} ${suppressAnnotations ? proseStyles.noAnnotations : ""}`}
      />
    </div>
  );
}
