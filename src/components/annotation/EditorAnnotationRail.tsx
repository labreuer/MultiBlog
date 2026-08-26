"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import AnnotationNode from "./AnnotationNode";
import QuoteThreadHeader from "../QuoteThreadHeader";
import { useMarginNotesLayout } from "../margin-notes/use-margin-notes-layout";
import { useMarginNotes } from "../margin-notes/margin-notes-context";
import { EDITOR_SCROLL_ATTRIBUTE } from "../editor-scroll";
import { useMediaQuery } from "@/lib/use-media-query";
import { EDITOR_FOCUS_MEDIA_QUERY } from "@/lib/margin-notes-layout";
import { resolveAnnotationRanges } from "@/lib/annotation-marks";
import type { AnnotationEntry } from "./AnnotationList";
import marginStyles from "../margin-notes/MarginNotes.module.css";
import styles from "./EditorAnnotationRail.module.css";

type Props = {
  entries: AnnotationEntry[];
  docId: string;
};

// Annotations shown alongside the doc *editor* (PLAN.md §18c), so an author
// revising a passage can see what has already been said about it without
// leaving for the reading view. Two deliberate differences from
// AnnotationList, which serves the reading view:
//
// - **Presently-anchored only, and nothing below.** No general-discussion
//   bucket, no card for an annotation whose mark is gone (§12h), no stacked
//   list under the editor at any width. The editing view answers "what is
//   attached to the text in front of me", and an annotation with no mark has
//   no answer to give here.
// - **A window, not a list.** The editor's body scrolls inside its own frame
//   (EditorChrome.module.css's .editorContent) rather than with the page, so
//   this rail is a fixed-height viewport onto the visible text: cards track
//   that internal scroll, and a card whose anchor has scrolled out of the
//   frame is hidden rather than piling up at an edge. That is what the layout
//   hook's `bounds` option exists for, and this is its only caller.
export default function EditorAnnotationRail({ entries, docId }: Props) {
  // Same live-document resolution the reading view uses, covering both
  // anchoring mechanisms (PLAN.md §13o) — see AnnotationList's own note on
  // why the server's `quotedText` isn't good enough to position against. It
  // matters more here: this surface is where the typing that invalidates the
  // snapshot is happening, and a reader's column-anchored annotation is
  // precisely what the author needs to see while editing the passage it is
  // about.
  const resolveTops = useCallback(
    (editor: Editor) => {
      const ranges = resolveAnnotationRanges(editor.state);
      const tops = new Map<string, number>();
      for (const entry of entries) {
        const range = ranges.get(entry.threadId);
        if (!range) continue;
        try {
          tops.set(entry.root.id, editor.view.coordsAtPos(range.from).top);
        } catch {
          // Unresolvable position; treated as unanchored, which in a bounded
          // rail means "not drawn".
        }
      }
      return tops;
    },
    [entries],
  );

  // The editor's scroll frame, found by attribute rather than by walking up
  // from `editor.view.dom`: the walk would encode .tiptap's exact parentage
  // in a second file, and the attribute says out loud which box is the
  // scroller.
  const bounds = useCallback(() => {
    const frame = document.querySelector<HTMLElement>(`[${EDITOR_SCROLL_ATTRIBUTE}]`);
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }, []);

  const ids = useMemo(() => entries.map((entry) => entry.root.id), [entries]);
  // Phone-landscape focus mode turns this rail into a queue (STYLE.md's
  // fourth breakpoint). Read here rather than taken from the provider's
  // `wide`, which is the *union* of the two clauses that can put a rail on
  // screen (EDITOR_MARGIN_NOTES_MEDIA_QUERY) and so cannot say which one
  // matched.
  const queued = useMediaQuery(EDITOR_FOCUS_MEDIA_QUERY);
  const { live, containerRef } = useMarginNotesLayout({ resolveTops, ids, bounds, positioned: !queued });

  // Document order, and only for the queue: the aligned rail's visual order
  // comes from where each card is *placed*, so its DOM order never mattered.
  // A flow list's is all it has, and `entries` arrive ordered by createdAt
  // (annotation-data.ts) — against the text that reads as a shuffle.
  //
  // Held in state and replaced only when the order genuinely changes, which
  // is the discipline the layout hook's own `reportedIdsRef` follows for the
  // same reason: this recomputes on every keystroke of a live document, and
  // re-rendering every card for a sort that came out identical is exactly the
  // cost margin notes go out of their way to avoid. Reordering takes text
  // being *moved*, so in practice it fires when an annotation appears or its
  // passage is deleted.
  const context = useMarginNotes();
  const orderingEditor = context?.editor ?? null;
  const subscribe = context?.subscribe;
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    if (!queued || !orderingEditor) return;
    const recompute = () => {
      const ranges = resolveAnnotationRanges(orderingEditor.state);
      const next = entries
        .map((entry, index) => ({ id: entry.root.id, index, from: ranges.get(entry.threadId)?.from }))
        // Anchorless last, input order among themselves — the rule
        // packMarginNotes documents for the positioned rail, repeated here so
        // that rotating the phone never reshuffles the same set of cards.
        .sort((a, b) => {
          if (a.from === undefined || b.from === undefined) {
            if (a.from === b.from) return a.index - b.index;
            return a.from === undefined ? 1 : -1;
          }
          return a.from - b.from || a.index - b.index;
        })
        .map((row) => row.id);
      setOrder((prev) => (prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next));
    };
    recompute();
    orderingEditor.on("update", recompute);
    const unsubscribe = subscribe?.(recompute);
    return () => {
      orderingEditor.off("update", recompute);
      unsubscribe?.();
    };
  }, [queued, orderingEditor, subscribe, entries]);

  const ordered = useMemo(() => {
    const byId = new Map(entries.map((entry) => [entry.root.id, entry]));
    const listed = order
      .map((id) => byId.get(id))
      .filter((entry): entry is AnnotationEntry => entry !== undefined);
    // Anything the order hasn't caught up with — a card that arrived in this
    // very render, before the effect above has run — still shows, at the end,
    // rather than blinking out for a frame.
    const seen = new Set(order);
    return [...listed, ...entries.filter((entry) => !seen.has(entry.root.id))];
  }, [entries, order]);

  // Nothing at all when there is no room (or before the editor has mounted).
  // Unlike the reading surfaces there is no stacked fallback to degrade to —
  // by design, per the header above.
  if (!live) {
    return null;
  }

  const card = (entry: AnnotationEntry) => (
    <div
      key={entry.root.id}
      data-thread-id={entry.threadId}
      data-thread-color={entry.color}
      data-margin-note-id={entry.root.id}
      className={marginStyles.entry}
    >
      <QuoteThreadHeader
        threadId={entry.threadId}
        quotedText={entry.quotedText}
        status="ACTIVE"
        context={null}
        color={entry.color}
      />
      <AnnotationNode annotation={entry.root} target={{ kind: "doc", id: docId }} />
    </div>
  );

  // The queue keeps `containerRef` even though nothing positions its cards:
  // rotating from the wide layout into this one has to clear the inline
  // `top`/`visibility` the positioned pass left on each card, and that
  // teardown is the layout hook's, reached through this same ref.
  if (queued) {
    return (
      <div ref={containerRef} className={`${marginStyles.list} ${styles.rail} ${styles.queue}`}>
        {ordered.map(card)}
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`${marginStyles.list} ${marginStyles.anchored} ${styles.rail}`}>
      {entries.map(card)}
    </div>
  );
}
