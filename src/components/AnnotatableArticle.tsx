"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { contentExtensions } from "@/lib/tiptap-schema";
import { QuoteHighlight, type QuoteHighlightThread } from "@/lib/quote-highlight-extension";
import { activatePseudoBordersForThread } from "@/lib/pseudo-border";
import { flashHighlight } from "@/lib/flash-highlight";
import { NEUTRAL_THREAD_COLOR } from "@/lib/author-colors";
import CommentForm from "./CommentForm";
import { useRegisterMarginNotesEditor } from "./margin-notes/margin-notes-context";
import proseStyles from "@/styles/prose.module.css";

type PendingSelection = {
  from: number;
  to: number;
  quotedText: string;
  top: number;
  left: number;
};

type Props = {
  postId: string;
  doc: JSONContent;
  threads: QuoteHighlightThread[];
  staticContent: ReactNode;
};

export default function AnnotatableArticle({ postId, doc, threads, staticContent }: Props) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      ...contentExtensions,
      QuoteHighlight.configure({
        threads,
        onIndicatorClick: (threadId) => {
          const targets = document.querySelectorAll<HTMLElement>(`[data-thread-id="${threadId}"]`);
          if (targets.length === 0) return;
          const color = threads.find((t) => t.id === threadId)?.color ?? NEUTRAL_THREAD_COLOR;
          targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
          targets.forEach((target) => flashHighlight(target, color));
          activatePseudoBordersForThread(threadId, color);
        },
      }),
    ],
    content: doc,
    editable: false,
    immediatelyRender: false,
    // The same aria-label/role pair the doc reading view's editor carries
    // (use-live-doc-content.ts) and for the same stated reason: it is what
    // the e2e suite keys off instead of DOM order (docs/TIPTAP.md's `.tiptap`
    // ordering note). This surface is the *original* selection-to-comment
    // one and had gone without, which is why nothing could address it —
    // `role: "textbox"` on an `editable: false` editor is the existing
    // convention here rather than a fresh judgement call.
    editorProps: { attributes: { "aria-label": "Post body", role: "textbox" } },
    onCreate: () => setReady(true),
    onSelectionUpdate: ({ editor: liveEditor }) => {
      const { from, to, empty } = liveEditor.state.selection;
      const container = containerRef.current;
      if (empty || !container) {
        setPending(null);
        return;
      }
      const quotedText = liveEditor.state.doc.textBetween(from, to, " ");
      if (!quotedText.trim()) {
        setPending(null);
        return;
      }
      const coords = liveEditor.view.coordsAtPos(to);
      const containerRect = container.getBoundingClientRect();
      setPending({
        from,
        to,
        quotedText,
        top: coords.bottom - containerRect.top,
        left: coords.left - containerRect.left,
      });
    },
    // Threads is otherwise baked into the QuoteHighlight plugin's options at
    // creation time and never re-read — without this dep, a comment posted
    // on this same page load (revalidatePath refreshes props, not a real
    // navigation) would never show its own highlight/badge until an actual
    // page reload.
  }, [threads]);

  // Lets CommentSection's cards sit level with the passages they quote
  // (PLAN.md §18). Gated on `ready` because until then this editor is
  // `display: none` behind the SSR'd static copy below, and coordsAtPos on a
  // hidden editor measures zeroes.
  useRegisterMarginNotesEditor(editor, ready);

  useEffect(() => {
    if (!pending) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPending(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [pending]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ display: ready ? "none" : "block" }}>{staticContent}</div>
      <div className={proseStyles.prose} style={{ display: ready ? "block" : "none" }}>
        <EditorContent editor={editor} />
      </div>
      {pending && (
        <div
          // Mirrors AnnotationPopover's own `annotation-popup` — both
          // reading surfaces' selection popovers need addressing by a test
          // without matching the *other* CommentForm this page also renders
          // (the general one below the article, whose buttons are named
          // identically).
          data-testid="comment-popup"
          style={{
            position: "absolute",
            top: pending.top + 6,
            left: pending.left,
            zIndex: 20,
            // No `width` — with only `left` set, an absolutely positioned box
            // with `width: auto` shrink-to-fits its content (CSS2.1 §10.3.7),
            // so dragging the textarea's resize handle (CommentForm.module.css
            // .textarea) grows this box right along with it instead of the
            // textarea overflowing a fixed-width panel. minWidth keeps the
            // pre-resize footprint identical to the old fixed 280px.
            minWidth: 280,
            background: "var(--surface)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 12,
            boxShadow: "0 2px 8px var(--shadow-color)",
          }}
        >
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 4 }}>
            Commenting on: “
            {pending.quotedText.length > 80 ? `${pending.quotedText.slice(0, 80)}…` : pending.quotedText}”
          </p>
          <CommentForm
            postId={postId}
            anchorFrom={pending.from}
            anchorTo={pending.to}
            quotedText={pending.quotedText}
            onPosted={() => setPending(null)}
            onCancel={() => setPending(null)}
          />
        </div>
      )}
    </div>
  );
}
