"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { contentExtensions } from "@/lib/tiptap-schema";
import { QuoteHighlight, type QuoteHighlightThread } from "@/lib/quote-highlight-extension";
import CommentForm from "./CommentForm";
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
  userName: string | null;
  staticContent: ReactNode;
};

// Briefly tints the target thread's section a light version of the
// thread's own color so it's obvious which comment(s) the quote indicator
// pointed at, then fades it back out.
function flashHighlight(element: HTMLElement, color: string) {
  element.style.transition = "background-color 0.3s ease-in";
  element.style.backgroundColor = `color-mix(in srgb, ${color} 35%, white)`;
  window.setTimeout(() => {
    element.style.transition = "background-color 1.5s ease-out";
    element.style.backgroundColor = "";
  }, 1000);
}

export default function AnnotatableArticle({ postId, doc, threads, userName, staticContent }: Props) {
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
          const color = threads.find((t) => t.id === threadId)?.color ?? "#999";
          targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
          targets.forEach((target) => flashHighlight(target, color));
        },
      }),
    ],
    content: doc,
    editable: false,
    immediatelyRender: false,
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
          style={{
            position: "absolute",
            top: pending.top + 6,
            left: pending.left,
            zIndex: 20,
            width: 280,
            background: "#fff",
            border: "1px solid #ccc",
            borderRadius: 4,
            padding: 12,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
        >
          <p style={{ fontSize: "0.85rem", color: "#666", marginBottom: 4 }}>
            Commenting on: “
            {pending.quotedText.length > 80 ? `${pending.quotedText.slice(0, 80)}…` : pending.quotedText}”
          </p>
          <CommentForm
            postId={postId}
            userName={userName}
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
