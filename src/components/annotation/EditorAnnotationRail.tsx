"use client";

import { useCallback, useMemo } from "react";
import type { Editor } from "@tiptap/react";
import AnnotationNode from "./AnnotationNode";
import QuoteThreadHeader from "../QuoteThreadHeader";
import { useMarginNotesLayout } from "../margin-notes/use-margin-notes-layout";
import { EDITOR_SCROLL_ATTRIBUTE } from "../editor-scroll";
import { collectAnnotationMarkRanges } from "@/lib/annotation-marks";
import type { AnnotationEntry } from "./AnnotationList";
import marginStyles from "../margin-notes/MarginNotes.module.css";
import styles from "./EditorAnnotationRail.module.css";

type Props = {
  entries: AnnotationEntry[];
  docId: string;
};

// Annotations shown alongside the doc *editor* (PLAN.md §18c), so an author
// revising a passage can see what has already been said about it without
// leaving for the reading view. Three deliberate differences from
// AnnotationList, which serves the reading view:
//
// - **Presently-anchored only, and nothing below.** No general-discussion
//   bucket, no card for an annotation whose mark is gone (§12h), no stacked
//   list under the editor at any width. The editing view answers "what is
//   attached to the text in front of me", and an annotation with no mark has
//   no answer to give here.
// - **Read-only cards.** No Reply, no Delete — see AnnotationNode's readOnly.
//   Creating annotations from the editor is not built yet, and a reply is a
//   creation.
// - **A window, not a list.** The editor's body scrolls inside its own frame
//   (EditorChrome.module.css's .editorContent) rather than with the page, so
//   this rail is a fixed-height viewport onto the visible text: cards track
//   that internal scroll, and a card whose anchor has scrolled out of the
//   frame is hidden rather than piling up at an edge. That is what the layout
//   hook's `bounds` option exists for, and this is its only caller.
export default function EditorAnnotationRail({ entries, docId }: Props) {
  // Same live-document scan the reading view uses — see AnnotationList's own
  // note on why the server's `quotedText` isn't good enough to position
  // against. It matters more here: this surface is where the typing that
  // invalidates the snapshot is happening.
  const resolveTops = useCallback(
    (editor: Editor) => {
      const ranges = collectAnnotationMarkRanges(editor.state.doc);
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
  const { anchored, containerRef } = useMarginNotesLayout({ resolveTops, ids, bounds });

  // Nothing at all when there is no room (or before the editor has mounted).
  // Unlike the reading surfaces there is no stacked fallback to degrade to —
  // by design, per the header above.
  if (!anchored) {
    return null;
  }

  return (
    <div ref={containerRef} className={`${marginStyles.list} ${marginStyles.anchored} ${styles.rail}`}>
      {entries.map((entry) => (
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
          <AnnotationNode annotation={entry.root} docId={docId} readOnly />
        </div>
      ))}
    </div>
  );
}
