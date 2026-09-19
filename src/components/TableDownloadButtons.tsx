"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { IconDownload } from "@tabler/icons-react";
import { TABLE_CODECS } from "@/lib/table-codecs";
import { downloadTableNode } from "@/lib/table-file-editor";
import { useMarginNotes } from "./margin-notes/margin-notes-context";
import proseStyles from "@/styles/prose.module.css";

// PLAN.md §24c — a "Download CSV" control under every table on a reading
// view, for readers who cannot open the editor. Mounted by both reading
// surfaces (AnnotatableArticle, DocReadingBody) beside their EditorContent.
//
// The control is portaled INTO the table's `.tableWrapper`, after the
// `<table>`. That is safe only because the table extension's node view
// ignores every mutation inside the wrapper but outside its content
// (`TableView.ignoreMutation`, @tiptap/extension-table 3.29.0) — ProseMirror
// would otherwise re-read the DOM and find a button where its document has
// none. It is a block after the table rather than an overlay in the
// corner because the wrapper is the horizontal scroll box, and an
// absolutely positioned child of a scroll box scrolls with the content;
// a row of text under the table costs a line of height and nothing else.
//
// The wrappers are read from the editor's DOM, never from the document
// JSON, so on the doc view this follows the *live* editor and never
// `Doc.proseJson` (CLAUDE.md). A remote edit that redraws a table comes
// through the margin-notes content-changed signal, which the doc view
// fires on every content push; the post page's content never changes
// after `ready`. useSyncExternalStore rather than state-in-an-effect: the
// snapshot is the DOM query, cached by element identity so a re-render
// with the same wrappers returns the same array.

const EMPTY: HTMLElement[] = [];

// The node a wrapper draws: posAtDOM at the wrapper's start lands inside
// the table, and the walk up finds it. Falls back to the nth table in
// document order, which is the nth wrapper in DOM order (nested tables
// included — both walks are document order).
function tableForWrapper(editor: Editor, wrapper: HTMLElement, index: number): PMNode | null {
  try {
    const $pos = editor.state.doc.resolve(editor.view.posAtDOM(wrapper, 0));
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.name === "table") return $pos.node(depth);
    }
  } catch {
    // posAtDOM throws for a node the view no longer knows; the fallback
    // below still answers.
  }
  let n = 0;
  let found: PMNode | null = null;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "table" && n++ === index) found = node;
    return true;
  });
  return found;
}

export default function TableDownloadButtons({ editor, ready }: { editor: Editor | null; ready: boolean }) {
  const marginNotes = useMarginNotes();
  const lastRef = useRef<HTMLElement[]>(EMPTY);

  const subscribe = useCallback(
    (listener: () => void) => (marginNotes ? marginNotes.subscribe(listener) : () => {}),
    [marginNotes],
  );
  const getSnapshot = useCallback(() => {
    if (!editor || !ready || editor.isDestroyed) return EMPTY;
    const next = Array.from(editor.view.dom.querySelectorAll<HTMLElement>(".tableWrapper"));
    const last = lastRef.current;
    if (next.length === last.length && next.every((el, i) => el === last[i])) return last;
    lastRef.current = next;
    return next;
  }, [editor, ready]);
  const wrappers = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);

  if (!editor || wrappers.length === 0) return null;

  const codec = TABLE_CODECS[0];

  function download(wrapper: HTMLElement, index: number) {
    if (!editor) return;
    const table = tableForWrapper(editor, wrapper, index);
    if (!table) return;
    const filename = wrappers.length > 1 ? `table-${index + 1}${codec.extensions[0]}` : `table${codec.extensions[0]}`;
    void downloadTableNode(table, codec, filename);
  }

  return wrappers.map((wrapper, index) =>
    createPortal(
      <button
        type="button"
        className={proseStyles.tableDownload}
        aria-label={`Download table as ${codec.label}`}
        title={`Download this table as ${codec.label}`}
        onClick={() => download(wrapper, index)}
      >
        <IconDownload size={14} aria-hidden="true" /> {codec.label}
      </button>,
      wrapper,
      `table-download-${index}`,
    ),
  );
}
