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
import { PendingAnnotation } from "@/lib/pending-annotation-extension";
import {
  AnnotationHighlight,
  setAnnotationAnchors,
  type AnnotationAnchorInput,
} from "@/lib/annotation-highlight-extension";
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
  // PLAN.md §18/COLLAB.md §5 — the doc editor's own selection-to-annotation
  // widget (useEditorAnnotationWidget), wired straight to useEditor's own
  // selection hook. No default: every other embedder (post editors,
  // /side-by-side, /ydoc-debug) simply never had one.
  onSelectionUpdate?: (editor: Editor) => void;
  // Fired synchronously on every local or remote transaction that changes
  // the doc — separate from the debounced author-stats walk below, since a
  // widget repositioning off a stale pixel offset for 400ms would visibly
  // lag the text it's supposed to track.
  onContentUpdate?: (editor: Editor) => void;
  // PLAN.md §13o — column-anchored annotations (written from a reading view)
  // have no mark in this document to render themselves, so an author editing
  // here would otherwise have no idea a reader had annotated the sentence
  // they're rewriting. Empty on every embedder that doesn't supply them,
  // which costs one plugin with nothing to draw.
  annotationAnchors?: AnnotationAnchorInput[];
  // Whether the initial sync has delivered the document yet. Only the doc
  // editor passes it, and only because of the anchor push below; a surface
  // with no column-anchored annotations has nothing that depends on it.
  synced?: boolean;
};

// Stable default — see DocReadingBody's identical constant.
const EMPTY_ANCHORS: AnnotationAnchorInput[] = [];

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
  onSelectionUpdate,
  onContentUpdate,
  annotationAnchors = EMPTY_ANCHORS,
  synced,
}: Props) {
  const [authorIds, setAuthorIds] = useState<string[]>([]);
  const [authorCharCounts, setAuthorCharCounts] = useState<Record<string, number>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read once at construction; later changes go through the meta transaction
  // below, since useEditor builds this editor exactly once (it is bound to a
  // Y.Doc and a websocket). Same two-step DocReadingBody uses. `useState`
  // rather than a ref because this *is* read during render, which is exactly
  // what react-hooks/refs forbids a ref for.
  const [initialAnchors] = useState(annotationAnchors);

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
      // View-only decoration (PLAN.md §13f) — never touches the ydoc, so
      // registering it unconditionally doesn't drift this schema from the
      // reading view's. Harmless on embedders with no selection widget.
      PendingAnnotation,
      // Also view-only, and for the same reason (PLAN.md §13o) — the
      // reading-view anchor's counterpart to the `Annotation` mark above.
      // Unlike the reading views, this editor has a real transaction mapping
      // to track those offsets through, so the ranges follow local typing
      // exactly rather than being re-found by text.
      AnnotationHighlight.configure({ anchors: initialAnchors }),
    ],
    // Matches the title field's own aria-label/role. Two contenteditables
    // share this page, and without distinct accessible names the only thing
    // telling them apart is DOM order — which is what the e2e suite would
    // otherwise have to key off (see docs/TIPTAP.md's `.tiptap` ordering note).
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox" } },
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => {
      // setTimeout(0), not queueMicrotask: onUpdate fires from inside
      // tiptap's own dispatchTransaction, mid-unwind of the transaction
      // that triggered it. onContentUpdate (useEditorAnnotationWidget's
      // reresolve) can itself update React state and, when a range no
      // longer resolves, dispatch a transaction on this same view — doing
      // either synchronously here reenters dispatchTransaction, which
      // ProseMirror documents as unsafe. A microtask still runs before the
      // browser has finished dispatching the *next* queued input event
      // under rapid typing; a macrotask waits for that to fully settle
      // first, at negligible cost since nothing reads the widget's
      // position before the next paint anyway. Observed as a real, if
      // intermittent, cursor/content desync during active typing without
      // this — e2e/quote-anchoring.spec.ts's "an edit outside the quote
      // moves the anchor" case, 2026-08-12.
      if (onContentUpdate) setTimeout(() => onContentUpdate(e), 0);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const { authorIds: ids, charsByAuthor } = perfMeasure("author-highlight walk", () =>
          collectAuthorHighlightStats(e.state.doc, "authorHighlight", "authorId"),
        );
        setAuthorIds(ids);
        setAuthorCharCounts(charsByAuthor);
      }, AUTHOR_STATS_DEBOUNCE_MS);
    },
    // Same reentrancy hazard and same fix as onUpdate above.
    onSelectionUpdate: ({ editor: e }) => {
      if (onSelectionUpdate) setTimeout(() => onSelectionUpdate(e), 0);
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

  // Same reason as `editable` above: the anchor set changes after
  // construction (a reader posts an annotation, this page refreshes) and the
  // extension's options were read once. PLAN.md §13o.
  //
  // `synced` is in the dependency list because a *collaborative* editor's
  // document does not exist yet when this first runs. A column anchor is
  // resolved by finding its `quotedText` in the document
  // (annotation-highlight-extension.ts's `resolveAll`), and this editor starts
  // empty and fills from Yjs — so the first push searched an empty document,
  // failed, and by that extension's tier-3 rule was never retried: "detachment
  // is re-evaluated on the next anchor push instead". There was no next push,
  // because `annotationAnchors` is memoised from server data and never changes
  // identity. The effect was therefore correct for the reading views, whose
  // editor is built around `initialBodyJSON` and has its text from the first
  // frame, and silently wrong here: every annotation written from a reading
  // view was invisible in the doc editor's rail — the one place PLAN.md §13o
  // says both mechanisms must answer alike.
  //
  // Pushing again on the sync is the fix the extension already asks for. This
  // flag is the right trigger rather than a document-changed check because it
  // means precisely "the content in front of you is the document" (DocEditor's
  // own note on it), which is the precondition for a text search to be
  // meaningful. Guarded by e2e/doc.spec.ts.
  useEffect(() => {
    if (!editor) return;
    setAnnotationAnchors(editor.view, annotationAnchors);
  }, [editor, annotationAnchors, synced]);

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
