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
// DocReadingBody, CollabEditorBody) and the surface that renders the cards
// beside it (CommentEntryList, AnnotationList, EditorAnnotationRail). They
// are siblings on every page that has both — the article is inside one
// server-rendered column and the rail inside another — so no prop can carry
// an editor handle across, the same reason DocPresenceProvider exists for
// awareness (PLAN.md §13i).
type MarginNotesContextValue = {
  // Null until the article's editor has actually mounted and painted.
  // Measuring a `display: none` editor (both reading views hide theirs behind
  // their SSR'd static copy until `ready`) returns zeroes, so registration is
  // deliberately gated on ready rather than on the editor object existing.
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
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

export function MarginNotesProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const listenersRef = useRef(new Set<() => void>());
  const wide = useMediaQuery(MARGIN_NOTES_MEDIA_QUERY);

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
    () => ({ editor, setEditor, subscribe, notifyContentChanged, wide }),
    [editor, subscribe, notifyContentChanged, wide],
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
