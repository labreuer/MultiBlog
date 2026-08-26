"use client";

import { createContext, useContext, type ReactNode } from "react";

// PLAN.md §19 — "the annotations on this surface changed; re-read them".
//
// **The default is a no-op, and that is /doc/[slug] unchanged.** A doc renders
// its annotations straight out of the server tree, so `router.refresh()` is
// both necessary and sufficient there. /pdf/[slug] cannot rely on that refresh
// alone — it is a transition rendering into the `ssr: false` Suspense boundary
// the viewer lives behind, and one that doesn't commit is silent
// (PdfAnnotationSurface's `liveEntries` carries the measurements) — so that
// surface provides this and re-reads the list itself.
//
// A context rather than a prop because two of the three callers are out of
// reach of one: AnnotationNode renders *itself* for replies, so a prop would
// have to be threaded through every nesting level for the benefit of the one
// surface that uses it. Same reason AnnotationMoveProvider and
// DocPresenceProvider are contexts rather than props.
//
// It carries no argument on purpose. "Something changed, go and look" survives
// a post, a reply, a delete and anything added later; a payload would have to
// be right about *what* changed, which is the part the server already knows.
const AnnotationReloadContext = createContext<() => void>(() => {});

export function useAnnotationReload(): () => void {
  return useContext(AnnotationReloadContext);
}

export function AnnotationReloadProvider({ reload, children }: { reload: () => void; children: ReactNode }) {
  return <AnnotationReloadContext.Provider value={reload}>{children}</AnnotationReloadContext.Provider>;
}
