"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/react";
import { useMediaQuery } from "@/lib/use-media-query";
import { MARGIN_NOTES_MEDIA_QUERY } from "@/lib/margin-notes-layout";

// The seam between the surface that *renders* the text (AnnotatableArticle,
// DocReadingBody, CollabEditorBody), the column the anchored cards are drawn
// in, and the section those cards are authored in — three subtrees that are
// siblings on every page that has them, so no prop can reach across. The same
// problem DocPresenceProvider solves for awareness (PLAN.md §13i).
type MarginNotesContextValue = {
  // Null until the article's editor has actually mounted and painted.
  // Measuring a `display: none` editor (both reading views hide theirs behind
  // their SSR'd static copy until `ready`) returns zeroes, so registration is
  // deliberately gated on ready rather than on the editor object existing.
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  // The empty column beside the article. Only *anchored* cards go here, and
  // they arrive by portal from the comment/annotation section that owns them
  // — see the entry lists for why they're not simply rendered here.
  railElement: HTMLElement | null;
  setRailElement: (element: HTMLElement | null) => void;
  // A plain listener set rather than a state counter. The doc reading view
  // pushes a new document into its editor on every remote keystroke, and
  // bumping React state for that would re-render the whole subtree under this
  // provider — the article *and* every comment card — once per keystroke, to
  // reposition cards that are moved imperatively anyway.
  subscribe: (listener: () => void) => () => void;
  notifyContentChanged: () => void;
  wide: boolean;
};

const MarginNotesContext = createContext<MarginNotesContextValue | null>(null);

// `query` exists for exactly one surface: the doc editor, which answers "is
// there room beside the document" differently from a reading view because its
// text column is elastic where theirs is a fixed reading measure
// (EDITOR_MARGIN_NOTES_MEDIA_QUERY's own note). It is a prop rather than a
// second context so the split stays where the decision is made — at the one
// mount site that differs — instead of every consumer learning there are two
// answers. Whatever is passed must be mirrored character-for-character by the
// surface's own CSS, which is the whole reason these are shared constants.
export function MarginNotesProvider({
  children,
  query = MARGIN_NOTES_MEDIA_QUERY,
}: {
  children: ReactNode;
  query?: string;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [railElement, setRailElement] = useState<HTMLElement | null>(null);
  const listenersRef = useRef(new Set<() => void>());
  const wide = useMediaQuery(query);

  const subscribe = useCallback((listener: () => void) => {
    const listeners = listenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const notifyContentChanged = useCallback(() => {
    for (const listener of listenersRef.current) listener();
  }, []);

  const value = useMemo(
    () => ({ editor, setEditor, railElement, setRailElement, subscribe, notifyContentChanged, wide }),
    [editor, railElement, subscribe, notifyContentChanged, wide],
  );

  return <MarginNotesContext.Provider value={value}>{children}</MarginNotesContext.Provider>;
}

// Null outside a provider, which is a supported state rather than an error:
// every consumer falls back to the plain stacked list it rendered before
// margin notes existed, so a surface can adopt the rail without every
// embedder having to.
export function useMarginNotes(): MarginNotesContextValue | null {
  return useContext(MarginNotesContext);
}

// The column itself: an empty div whose only job is to exist at the right
// place in the grid and hand its DOM node to whichever entry list is going to
// portal cards into it.
export function MarginNotesRail({ className }: { className?: string }) {
  const setRailElement = useContext(MarginNotesContext)?.setRailElement;

  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      setRailElement?.(element);
    },
    [setRailElement],
  );

  return <div className={className} ref={ref} />;
}

// Called by whichever component owns the article's editor. Split out so the
// three call sites share the ready-gating and the unmount cleanup rather than
// each writing their own effect. A no-op outside a provider, so
// CollabEditorBody's other embedders (/side-by-side, /ydoc-debug) are
// unaffected by the doc editor adopting it.
export function useRegisterMarginNotesEditor(editor: Editor | null, ready: boolean) {
  const setEditor = useContext(MarginNotesContext)?.setEditor;

  useEffect(() => {
    if (!setEditor) return;
    setEditor(ready ? editor : null);
    return () => setEditor(null);
  }, [setEditor, editor, ready]);
}
