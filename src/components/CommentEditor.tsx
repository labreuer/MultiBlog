"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { UndoRedo } from "@tiptap/extensions";
import { ListKeymap } from "@tiptap/extension-list";
import { searchCommentCitable, searchCommentMentionable } from "@/app/actions/comment-chips";
import { commentContentExtensions } from "@/lib/tiptap-schema";
import { commentChipInputs } from "@/lib/comment-body";
import { CITATION, type CitedWork } from "@/lib/entity-chips/kinds/citation";
import { MENTION, type MentionUser } from "@/lib/entity-chips/kinds/mention";
import { mergeChipContexts } from "@/lib/entity-chips/renderings";
import type { ChipContext } from "@/lib/entity-chips/types";
import { useChipInputs } from "@/lib/entity-chips/use-chip-inputs";
import { useCommentChips } from "./comment-chips-context";
import { VirtualKeyboardEnter } from "@/lib/virtual-keyboard-enter-extension";
import { Indent } from "@/lib/indent-extension";
import { FormatInputEvents } from "@/lib/format-input-extension";
import EditorToolbar, { type ToolbarTool } from "./EditorToolbar";
import { MentionSuggestions, type MentionSource } from "./MentionMenu";
import { CiteSuggestions, type CiteSource } from "./CiteMenu";
import CitePopover from "./CitePopover";
import proseStyles from "@/styles/prose.module.css";
import bodyStyles from "./CommentBody.module.css";
import styles from "./CommentEditor.module.css";

// PLAN.md §23h — the rich comment composer's reduced tool set. No headings
// (not in the schema), no tighten (a comment is short); undo/redo come from
// UndoRedo below rather than from Collaboration, since there is no ydoc here.
export const COMMENT_TOOLS: ToolbarTool[] = [
  "undo",
  "redo",
  "bold",
  "italic",
  "link",
  "bullets",
  "numbered",
  "quote",
  "indent",
  "outdent",
  "clear",
];

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
  /** The post the comment is on: what its `@` and `[@` menus are asked of. */
  postId: string;
  /** The comment being edited: the endpoint the editor asks about a chip the page has no record of. */
  commentId?: string;
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
  postId,
  commentId,
}: Props) {
  // A ref rather than a captured closure: useEditor's options are read once
  // at construction, and the parent's onChange is recreated per render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    extensions: [...commentContentExtensions, UndoRedo, ListKeymap, VirtualKeyboardEnter, Indent, FormatInputEvents],
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

  // docs/ENTITY_CHIPS.md, "Chips in comments" — the chips' labels, in the
  // comment style, from the page's records; an edit asks the endpoint about
  // any chip they don't hold. A new comment has nothing stored to ask about,
  // and its chips come with the records that put them there: the page's, a
  // conversion's, or a menu's (`seeded`).
  const { context: chipContext } = useCommentChips();
  const initialChips = useMemo(() => commentChipInputs(chipContext), [chipContext]);
  const [seeded, setSeeded] = useState<ChipContext>({});
  const seed = useCallback((kind: string, id: string, record: unknown) => {
    setSeeded((previous) => mergeChipContexts(previous, { [kind]: { [id]: record } }));
  }, []);
  const chipSurface = useMemo(
    () => ({ target: commentId ? { comment: commentId } : null, initial: initialChips, seeded }),
    [commentId, initialChips, seeded],
  );
  useChipInputs(editor, chipSurface);

  // The menus ask of the post, signed in or not: the server decides whom and
  // what this commenter is offered (src/lib/comment-chips.ts).
  const mentions = useMemo<MentionSource>(
    () => ({
      search: async (query) => (await searchCommentMentionable(query, postId)).map((user) => ({ user, note: null })),
      seed: (user: MentionUser) => seed(MENTION, user.id, user),
    }),
    [postId, seed],
  );
  const citations = useMemo<CiteSource>(
    () => ({ search: (words) => searchCommentCitable(words, postId), seed: (work: CitedWork) => seed(CITATION, work.id, work) }),
    [postId, seed],
  );

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
      <MentionSuggestions editor={editor} disabled={disabled} source={mentions} />
      <CiteSuggestions editor={editor} disabled={disabled} source={citations} emptyQueryHeading="Cited in this post" />
      <CitePopover editor={editor} disabled={disabled} source={citations} narrativeForm={false} />
    </div>
  );
}
