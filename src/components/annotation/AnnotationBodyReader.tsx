"use client";

import { useState, type ReactNode } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { annotationContentExtensions } from "@/lib/tiptap-schema";
import styles from "./AnnotationBodyReader.module.css";

type Props = {
  /** The annotation's body, from its own ydoc cache. Null for one that never reached a store debounce. */
  proseJson: JSONContent | null;
  /**
   * The server's static rendering of the same content — shown until the
   * editor below reports ready, and the only thing a reader with no JS ever
   * sees. Not a loading placeholder: it is the identical content, so the swap
   * is invisible.
   */
  staticBody: ReactNode;
};

// PLAN.md §13p — a posted annotation's body, rendered through a **read-only
// ProseMirror editor** rather than as the static React tree it used to be
// (annotation-entries.ts still produces that tree; it is now the pre-ready
// copy rather than the whole story).
//
// The static render was correct and cheaper, and would still be enough if a
// body only ever had to be *read*. What it cannot do is answer "which
// characters did the reader just select", in the coordinates anything else
// can use — a browser Selection over an arbitrary React tree gives DOM nodes
// and offsets, and turning those back into document positions means
// reimplementing what ProseMirror already does exactly. Nor can it carry
// decorations, which is how a reply's anchored quote gets highlighted inside
// the parent it points at.
//
// Same behind-the-SSR-copy shape AnnotatableArticle and DocReadingBody use:
// the server-rendered body is shown until `ready`, then swapped for the
// editor's identical DOM. That keeps this surface working with no JS, and
// keeps the first paint free of a flash.
//
// **One editor per rendered annotation** is the cost, and it is a real one on
// a doc with many of them — a deliberate choice to mirror the two surfaces
// above rather than invent a lazier scheme whose failure mode (mounting mid
// selection-gesture) would be a worse bug than the cost it avoids. If a
// heavily-annotated doc measures badly, mounting on first pointer/focus
// contact is the escape hatch, with eager mounting kept for any annotation
// that has anchored replies to decorate.
export default function AnnotationBodyReader({ proseJson, staticBody }: Props) {
  const [ready, setReady] = useState(false);

  const editor = useEditor({
    // No `annotation` mark, matching annotationContentExtensions
    // (tiptap-schema.ts): an annotation body can't carry an anchor *onto*
    // another annotation, and §13p doesn't change that — a reply anchored
    // into this body is anchored by columns, decorated from outside, never
    // by a mark written in here.
    extensions: annotationContentExtensions,
    content: proseJson ?? { type: "doc", content: [{ type: "paragraph" }] },
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": "Annotation", role: "textbox" } },
    onCreate: () => setReady(true),
  });

  return (
    <div className={styles.body}>
      <div style={{ display: ready ? "none" : "block" }}>{staticBody}</div>
      <div style={{ display: ready ? "block" : "none" }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
