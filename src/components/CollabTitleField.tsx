"use client";

import { useEffect, useMemo, useState } from "react";
import { Extension } from "@tiptap/core";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import type * as Y from "yjs";
import { AuthorHighlight } from "@/lib/author-highlight-extension";
import { collectAuthorHighlightStats, titleExtensions } from "@/lib/tiptap-schema";
import { useAuthorColors } from "@/lib/use-author-colors";
import AuthorHighlightStyles from "./AuthorHighlightStyles";

type Props = {
  ydoc: Y.Doc;
  userId: string;
  userName: string;
  userColor: string;
  editable?: boolean;
  className?: string;
  onTitleChange: (title: string) => void;
  onEditorReady: (editor: Editor | null) => void;
};

// Enter would otherwise attempt a splitBlock that the `content: "paragraph"`
// schema rejects anyway; making it an explicit no-op keeps it from also
// scrolling//bubbling as a failed command.
const SingleLine = Extension.create({
  name: "titleSingleLine",
  addKeyboardShortcuts() {
    return { Enter: () => true };
  },
});

// The post title, as a collaborative field rather than a plain <input>: it's a
// second Yjs fragment ("title") of the *same* Y.Doc the body uses, so it rides
// the existing Hocuspocus connection, PostCollab.ydoc persistence, and
// PostCollabUpdate replay log — which is what lets /posts/[id]/live-history
// scrub through title changes, colored per author, for free.
//
// Deliberately no CollaborationCaret: the extension has no per-field awareness
// key, so a second instance sharing this provider would write the same
// `awareness.cursor` as the body editor's and render each other's positions
// against the wrong fragment. Text still syncs live; only remote carets are
// absent here.
export default function CollabTitleField({
  ydoc,
  userId,
  userName,
  userColor,
  editable = true,
  className,
  onTitleChange,
  onEditorReady,
}: Props) {
  const [authorIds, setAuthorIds] = useState<string[]>([]);

  const editor = useEditor({
    extensions: [
      ...titleExtensions,
      SingleLine,
      Collaboration.configure({ document: ydoc, field: "title" }),
      AuthorHighlight.configure({ getAuthorId: () => userId }),
    ],
    editorProps: { attributes: { "aria-label": "Title", role: "textbox" } },
    immediatelyRender: false,
  });

  useEffect(() => {
    onEditorReady(editor);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  // Reporting upward happens here rather than in a useEditor `onUpdate`
  // callback because the first Yjs sync's transaction can land during
  // useEditor's construction — i.e. during *render*, which makes a parent
  // setState from there the "state update on a component that hasn't mounted
  // yet" React warns about. Reporting once on mount catches that case; the
  // `update` subscription catches every later keystroke and every remote
  // change, including a sync that arrives after mount.
  //
  // A title is one short line, so unlike the body editor's stats walk (see
  // PERFORMANCE.md) there's nothing here worth debouncing — and reporting the
  // text per keystroke is exactly what the <input> this replaces did.
  useEffect(() => {
    if (!editor) return;
    const report = () => {
      onTitleChange(editor.getText());
      const { authorIds: ids } = collectAuthorHighlightStats(editor.state.doc, "authorHighlight", "authorId");
      setAuthorIds(ids);
    };
    report();
    editor.on("update", report);
    return () => {
      editor.off("update", report);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // useEditor's `editable` option is only read at construction time — same
  // reason CollabEditorBody calls setEditable directly.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const knownColors = useMemo(
    () => ({ [userId]: { name: userName, color: userColor } }),
    [userId, userName, userColor],
  );
  const authorColors = useAuthorColors(authorIds, knownColors);

  return (
    <>
      {/* A second AuthorHighlightStyles alongside CollabEditorBody's is
          harmless — both emit the same global
          `.author-highlight[data-author-id]` rules — and it's what colors a
          contributor who has touched only the title. */}
      <AuthorHighlightStyles colors={authorColors} />
      <EditorContent editor={editor} className={className} />
    </>
  );
}
