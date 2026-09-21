"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// PLAN.md §12p/§13 — lets an annotation's own "jump to this revision"
// control (AnnotationNode) reach DocScrubBar's slider, which is a sibling
// subtree in page.tsx (DocView vs. AnnotationSection), not a parent/child —
// the same cross-tree problem AnnotationMoveProvider/DocPresenceProvider
// already solve, solved the same way again.

// Returns whether the seek happened — false when the bar's replay holds no
// such update, which is a real case (an annotation carried over from another
// doc's log, a hand-edited URL). AnnotationNode's control is a link as well as
// a button, and it uses the answer to decide whether to swallow the click or
// let the browser follow the href and let a fresh page load try instead.
type SeekFn = (updateId: string) => boolean;

type Ctx = {
  registerSeek: (fn: SeekFn | null) => void;
  seekToUpdateId: SeekFn | null;
  hasScrubBar: boolean;
};

const DocScrubContext = createContext<Ctx | null>(null);

// `hasScrubBar` is whether this page renders a scrub bar at all — page.tsx's
// own `canEdit`, the same value DocView gates the bar on, passed in rather
// than derived from the bar having mounted. Two reasons it is a prop: a
// reader who may read but not edit gets a provider and no bar (the provider
// wraps both subtrees unconditionally, above where the bar's gate applies),
// so the context's mere existence answers the wrong question; and an
// effect-registered "I exist" would make every "at this revision" link pop
// in after hydration instead of arriving in the server's HTML.
export function DocScrubProvider({ children, hasScrubBar }: { children: ReactNode; hasScrubBar: boolean }) {
  const [seekFn, setSeekFn] = useState<SeekFn | null>(null);

  // The `() => fn` form, not `setSeekFn(fn)` directly — React's setState
  // treats a bare function argument as an updater, which would call `fn`
  // with the previous state instead of storing it.
  const registerSeek = useCallback((fn: SeekFn | null) => {
    setSeekFn(() => fn);
  }, []);

  const value = useMemo(
    () => ({ registerSeek, seekToUpdateId: seekFn, hasScrubBar }),
    [registerSeek, seekFn, hasScrubBar],
  );

  return <DocScrubContext.Provider value={value}>{children}</DocScrubContext.Provider>;
}

// Whether this page has a scrub bar on it at all — true on /doc/[slug] for a
// viewer who may edit the doc, false in the doc editor's rail, on a PDF, and
// for a reader who only has read access. Distinct from useDocScrub() being
// non-null, which additionally means that bar has loaded its replay and can
// seek *now*: a control that only needs somewhere to link to (docs/DOCS.md,
// "?at=") can render on the strength of this alone, which is what lets "at
// this revision" appear before the reader has touched the slider rather than
// only after.
export function useHasDocScrub(): boolean {
  return useContext(DocScrubContext)?.hasScrubBar ?? false;
}

// Null outside a provider, and null-valued even inside one until DocScrubBar
// has actually loaded its replay — both are supported states, same
// null-is-supported convention as useMarginNotes(): a reader who has never
// touched the scrub bar (or a page with no scrub bar at all, like
// /doc/[slug]/edit) simply has nowhere for "jump to this revision" to seek.
// The one caller answers that by falling back to the link's own href, which
// gets there through a page load instead; useHasDocScrub above is what
// decides whether to render the control at all.
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
