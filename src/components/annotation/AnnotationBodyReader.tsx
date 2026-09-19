"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { annotationContentExtensions } from "@/lib/tiptap-schema";
import { PendingAnnotation, setPendingAnnotation } from "@/lib/pending-annotation-extension";
import { AnnotationClick } from "@/lib/annotation-click-extension";
import {
  AnnotationHighlight,
  annotationHighlightKey,
  setAnnotationAnchors,
  type AnnotationAnchorInput,
} from "@/lib/annotation-highlight-extension";
import proseStyles from "@/styles/prose.module.css";
import styles from "./AnnotationBodyReader.module.css";

export type BodySelection = { from: number; to: number; quotedText: string };

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
  /**
   * PLAN.md §13p — every reply that quotes a range of *this* body, so the
   * quoted text can be highlighted in the replying author's own color. Empty
   * for an annotation whose replies were all made from the plain Reply
   * button.
   */
  replyAnchors?: AnnotationAnchorInput[];
  /**
   * The range a reply currently being composed points at, drawn as the same
   * "about to be acted on" decoration a doc selection gets (§13f). Distinct
   * from `replyAnchors` above: those are posted, this one isn't yet.
   */
  pending?: { from: number; to: number; color: string } | null;
  /**
   * Fired on every **non-empty** selection in this body. Empty selections are
   * deliberately not reported at all — see the note at the call site.
   */
  onSelect?: (selection: BodySelection) => void;
  /** Clicking a highlighted range: the ids of the replies anchored over it. */
  onAnchorClick?: (replyIds: string[]) => void;
  /**
   * Which of `replyAnchors` currently resolve in this body, reported whenever
   * that set changes (PLAN.md §22e).
   *
   * The complement is what the caller wants: a reply whose quote no longer
   * appears here is one whose parent has been edited away from the words it
   * answered, and it is offered a link to the version it quoted. Reported
   * from here because this is where the answer already exists — the highlight
   * plugin resolves all three tiers per transaction, and asking a second time
   * outside would be the same scan again.
   */
  onResolvedAnchorsChange?: (resolvedIds: string[]) => void;
};

// A stable default, so the anchor-push effect doesn't fire every render on an
// annotation with no anchored replies.
const EMPTY_ANCHORS: AnnotationAnchorInput[] = [];

// A body that never reached a store debounce. A module constant so the
// content-push effect below can compare against a stable value.
const EMPTY_BODY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

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
export default function AnnotationBodyReader({
  proseJson,
  staticBody,
  replyAnchors = EMPTY_ANCHORS,
  pending = null,
  onSelect,
  onAnchorClick,
  onResolvedAnchorsChange,
}: Props) {
  const [ready, setReady] = useState(false);
  // The editor is built once; these handlers change per render, so they are
  // reached through refs rather than baked into extension options that could
  // never be updated. Same shape DocReadingBody's own once-only editor uses.
  const onSelectRef = useRef(onSelect);
  const onAnchorClickRef = useRef(onAnchorClick);
  const onResolvedRef = useRef(onResolvedAnchorsChange);
  // The last set reported, so an unchanged answer doesn't re-render the
  // parent on every keystroke of an unrelated edit.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    onSelectRef.current = onSelect;
    onAnchorClickRef.current = onAnchorClick;
    onResolvedRef.current = onResolvedAnchorsChange;
  });
  const [initialAnchors] = useState(replyAnchors);
  // The content this editor was constructed with, and every later push. See
  // the effect below for why it has to be tracked by hand.
  const [initialBody] = useState<JSONContent>(() => proseJson ?? EMPTY_BODY);
  const appliedBodyRef = useRef<JSONContent>(initialBody);

  const editor = useEditor({
    // No `annotation` mark, matching annotationContentExtensions
    // (tiptap-schema.ts): an annotation body can't carry an anchor *onto*
    // another annotation, and §13p doesn't change that — a reply anchored
    // into this body is anchored by columns and decorated from outside,
    // never by a mark written in here. That is also why the two extensions
    // below are the decoration-only pair rather than the doc's mark.
    extensions: [
      ...annotationContentExtensions,
      PendingAnnotation,
      // PLAN.md §22e — `retryDetached` is true here and nowhere else: this is
      // the one surface whose tracked document is an annotation body, small
      // enough that re-searching a detached reply anchor on every content
      // change is free. It is what lets a reply re-attach live as its parent
      // is edited back toward the words it quoted.
      AnnotationHighlight.configure({ anchors: initialAnchors, retryDetached: true }),
      // eslint-disable-next-line react-hooks/refs -- onHit is only ever invoked from the AnnotationClick plugin's handleClick, on a real DOM click, never during React's render
      AnnotationClick.configure({ onHit: (ids) => onAnchorClickRef.current?.(ids) }),
    ],
    content: initialBody,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": "Annotation", role: "textbox" } },
    onCreate: () => setReady(true),
    onSelectionUpdate: ({ editor: liveEditor }: { editor: Editor }) => {
      const { from, to, empty } = liveEditor.state.selection;
      // **An empty selection is ignored, not reported as "nothing selected".**
      // This is the one place this surface deliberately differs from
      // useSelectionPopover, which clears on empty. Here the composer that
      // consumes the selection is a *sibling editor* on the same page:
      // clicking into it collapses this body's selection, and treating that
      // as "the reader deselected" would wipe the anchor at the exact moment
      // they started typing about it. An anchor is replaced by a new
      // selection or not at all.
      if (empty) return;
      const quotedText = liveEditor.state.doc.textBetween(from, to, " ");
      if (!quotedText.trim()) return;
      onSelectRef.current?.({ from, to, quotedText });
    },
  });

  // PLAN.md §22e — **a posted body is mutable now, so the prop can change under
  // a mounted editor**, and `useEditor`'s `content` is a construction-time
  // option: @tiptap/react's re-render path calls `editor.setOptions`, and core's
  // `setOptions` merges the options and calls `view.updateState(this.state)`
  // without ever re-parsing `content`. So a changed `proseJson` has to be
  // pushed in, exactly as use-live-doc-content.ts pushes a doc's live updates.
  //
  // Without it, ending an edit session showed the *previous* text: the card
  // remounts this reader with the pre-edit prop (Done and `router.refresh()`
  // are one batch), the refresh then lands with the new body, and the editor
  // kept the old one — visible until a full page load. The `staticBody` copy
  // underneath had the new text the whole time, hidden behind `display: none`.
  //
  // Compared by value, not identity: an RSC refresh deserializes a fresh
  // object every time, so an identity check would re-`setContent` on every
  // unrelated refresh and collapse a selection the reader was holding.
  useEffect(() => {
    if (!editor) return;
    const next = proseJson ?? EMPTY_BODY;
    if (next === appliedBodyRef.current) return;
    if (JSON.stringify(next) === JSON.stringify(appliedBodyRef.current)) return;
    appliedBodyRef.current = next;
    editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, proseJson]);

  // Which anchors resolve, reported after every transaction that could have
  // changed the answer — a content change, and the anchor push below.
  //
  // In an effect rather than inside the plugin: the plugin is shared with the
  // doc surfaces, which have no use for this, and a plugin that called back
  // into React from `apply` would be dispatching state updates from inside a
  // ProseMirror transaction.
  useEffect(() => {
    if (!editor) return;
    const report = () => {
      const state = annotationHighlightKey.getState(editor.state);
      if (!state) return;
      const resolved = [...state.ranges.keys()].sort();
      const key = resolved.join(" ");
      if (key === lastReportedRef.current) return;
      lastReportedRef.current = key;
      onResolvedRef.current?.(resolved);
    };
    report();
    editor.on("transaction", report);
    return () => {
      editor.off("transaction", report);
    };
  }, [editor]);

  // Posted anchors change when a reply is posted or deleted (router.refresh()).
  useEffect(() => {
    if (!editor) return;
    setAnnotationAnchors(editor.view, replyAnchors);
  }, [editor, replyAnchors]);

  // The in-progress one changes as the reader drags, and clears when the
  // composer closes.
  useEffect(() => {
    if (!editor) return;
    setPendingAnnotation(editor.view, pending);
  }, [editor, pending]);

  // `.prose` on both copies, not just the editor's. Every decoration this
  // surface draws is styled by a rule *scoped under `.prose`* in
  // prose.module.css — `.pending-annotation` and `.annotation-highlight`
  // both — so without it the decorations are dispatched, the spans are in
  // the DOM, and nothing paints: a selection inside an annotation looked
  // like it did nothing at all. This is CLAUDE.md's "any new surface
  // rendering post content needs its `.prose` class" with a second
  // consequence that note doesn't mention, since every earlier surface
  // happened to want the class for its list/blockquote styling anyway and
  // got the decorations for free.
  //
  // It also fixes something older by the same mechanism: an annotation's
  // *static* body never had `.prose` either, so a list or blockquote written
  // in an annotation has been rendering stripped by globals.css's reset the
  // whole time — while the same content in the composer, which does carry
  // the class (AnnotationBody.tsx), looked right.
  return (
    <div className={styles.body}>
      <div className={`${proseStyles.prose} ${styles.type} ${styles.copy}`} style={{ display: ready ? "none" : "block" }}>
        {staticBody}
      </div>
      <div className={`${proseStyles.prose} ${styles.type} ${styles.copy}`} style={{ display: ready ? "block" : "none" }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
