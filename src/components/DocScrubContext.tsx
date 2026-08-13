"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// PLAN.md §12p/§13 — lets an annotation's own "jump to this revision"
// control (AnnotationNode) reach DocScrubBar's slider, which is a sibling
// subtree in page.tsx (DocView vs. AnnotationSection), not a parent/child —
// the same cross-tree problem AnnotationMoveProvider/DocPresenceProvider
// already solve, solved the same way again.
type SeekFn = (updateId: string) => void;

type Ctx = {
  registerSeek: (fn: SeekFn | null) => void;
  seekToUpdateId: SeekFn | null;
};

const DocScrubContext = createContext<Ctx | null>(null);

export function DocScrubProvider({ children }: { children: ReactNode }) {
  const [seekFn, setSeekFn] = useState<SeekFn | null>(null);

  // The `() => fn` form, not `setSeekFn(fn)` directly — React's setState
  // treats a bare function argument as an updater, which would call `fn`
  // with the previous state instead of storing it.
  const registerSeek = useCallback((fn: SeekFn | null) => {
    setSeekFn(() => fn);
  }, []);

  const value = useMemo(() => ({ registerSeek, seekToUpdateId: seekFn }), [registerSeek, seekFn]);

  return <DocScrubContext.Provider value={value}>{children}</DocScrubContext.Provider>;
}

// Null outside a provider, and null-valued even inside one until DocScrubBar
// has actually loaded its replay — both are supported states, same
// null-is-supported convention as useMarginNotes(): a reader who has never
// touched the scrub bar (or a page with no scrub bar at all, like
// /doc/[slug]/edit) simply has nowhere for "jump to this revision" to seek,
// so callers render nothing rather than a broken control.
export function useDocScrub(): SeekFn | null {
  return useContext(DocScrubContext)?.seekToUpdateId ?? null;
}

// Called by DocScrubBar's LoadedScrubBar once it can map a ydoc_update id to
// a slider index — never any earlier, since that mapping needs
// replay.updates, which doesn't exist before the reader's first fetch.
// `fn` should be stable across renders (wrap it in useCallback at the call
// site) — this re-registers on every identity change, and the provider's
// state update on each one would otherwise re-render everything under it
// on every scrub tick.
export function useRegisterDocScrubSeek(fn: SeekFn | null): void {
  const registerSeek = useContext(DocScrubContext)?.registerSeek;
  useEffect(() => {
    registerSeek?.(fn);
    return () => registerSeek?.(null);
  }, [registerSeek, fn]);
}
