"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { annotationEditorExtensions } from "@/lib/live-editor-extensions";
import EditorToolbar, { ANNOTATION_TOOLS } from "../EditorToolbar";
import DocRefMenu from "../DocRefMenu";
import MentionMenu from "../MentionMenu";
import CiteMenu from "../CiteMenu";
import CitePopover from "../CitePopover";
import { ChipSurfaceProvider, useChipSurface } from "@/lib/entity-chips/chip-surface";
import type { ChipInputs } from "@/lib/entity-chips/types";
import { useChipInputs } from "@/lib/entity-chips/use-chip-inputs";
import proseStyles from "@/styles/prose.module.css";
import readerStyles from "./AnnotationBodyReader.module.css";
import styles from "./AnnotationBody.module.css";

const TOOLBAR_STORAGE_KEY = "multiblog.annotationToolbar";

type Props = {
  /** Whose body this is: what its entity chips are labelled for, and who its mention menu lists. */
  annotationId: string;
  /** What the card this editor replaces labelled its chips with, when there was one. */
  chipInputs?: ChipInputs;
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  userId: string;
  userName: string;
  userColor: string;
  editable?: boolean;
  // LiveAnnotationComposer's `bounded`, passed down: this frame is in a box
  // of limited height, and the editor is what shrinks.
  bounded?: boolean;
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
//
// The body is its own chip surface (docs/ENTITY_CHIPS.md, step 1, item 13):
// its chips are the annotation's, not those of the doc the page is showing,
// so the provider here stands in for the page's.
export default function AnnotationBody({ annotationId, chipInputs, ...props }: Props) {
  return (
    <ChipSurfaceProvider annotation={annotationId} initial={chipInputs}>
      <AnnotationBodyEditor {...props} />
    </ChipSurfaceProvider>
  );
}

function AnnotationBodyEditor({
  provider,
  ydoc,
  userId,
  userName,
  userColor,
  editable = true,
  bounded = false,
  onEditorReady,
}: Omit<Props, "annotationId" | "chipInputs">) {
  const [toolbarVisible, setToolbarVisible] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from localStorage (an external system)
    setToolbarVisible(window.localStorage.getItem(TOOLBAR_STORAGE_KEY) === "1");
  }, []);

  // PLAN.md §13h — author highlighting stays off until a *second* distinct
  // author shows up on this annotation's own `clients` map (§11d, the same
  // server-written clientID -> userId attribution a doc already has). A
  // ref, not state: AuthorHighlight.configure's getAuthorId closure is
  // captured once at useEditor construction and never recreated, so a
  // stale `coAuthoring` boolean captured there would never see this flip.
  const coAuthoringRef = useRef(false);

  useEffect(() => {
    const clients = ydoc.getMap<string>("clients");
    const update = () => {
      coAuthoringRef.current = new Set(clients.values()).size >= 2;
    };
    update();
    clients.observe(update);
    return () => clients.unobserve(update);
  }, [ydoc]);

  const editor = useEditor({
    // The whole list is live-editor-extensions.ts's, and nothing is added
    // beside it here: that file says why.
    // eslint-disable-next-line react-hooks/refs -- getAuthorId is only ever invoked from the AuthorHighlight plugin's appendTransaction, on a real ProseMirror transaction dispatch, never during React's render
    extensions: annotationEditorExtensions({
      ydoc,
      provider,
      user: { id: userId, name: userName, color: userColor },
      getAuthorId: () => (coAuthoringRef.current ? userId : null),
    }),
    editorProps: { attributes: { "aria-label": "Annotation body", role: "textbox" } },
    immediatelyRender: false,
  });

  useChipInputs(editor, useChipSurface());

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
    <div className={`${styles.frame} ${bounded ? styles.bounded : ""}`}>
      {toolbarVisible && <EditorToolbar editor={editor} disabled={!editable} tools={ANNOTATION_TOOLS} />}
      <EditorContent
        editor={editor}
        // `readerStyles.type` so the box you type in is set exactly like the
        // posted body above it — CommentEditor wears CommentBody's `.body` for
        // the same reason.
        className={`${styles.content} ${proseStyles.prose} ${readerStyles.type}`}
      />
      <DocRefMenu editor={editor} disabled={!editable} />
      <MentionMenu editor={editor} disabled={!editable} />
      <CiteMenu editor={editor} disabled={!editable} />
      <CitePopover editor={editor} disabled={!editable} />
      {editable && (
        <button type="button" onClick={toggleToolbar} className={styles.toolbarToggle}>
          {toolbarVisible ? "Hide formatting" : "Aa Formatting"}
        </button>
      )}
    </div>
  );
}
