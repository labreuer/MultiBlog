"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { createCollabSocket, type CollabSocket } from "@/lib/collab-socket";

// The Awareness class itself lives in y-protocols, a transitive dependency
// (not declared directly in package.json) — HocuspocusProvider's own
// `.awareness` property type is what's actually stable to depend on here,
// so this reads it off that instead of importing y-protocols/awareness
// directly, same as the rest of this codebase never does either.
type Awareness = HocuspocusProvider["awareness"];

// The page-level collab plumbing shared between sibling trees — the surface
// that owns the document (DocReadingBody, DocEditor, the PDF viewer) and the
// annotation tree beside it, which page.tsx renders as a sibling rather than
// a child. Same cross-tree problem AnnotationMoveProvider already solves for
// "Move to bottom", solved the same way here for two things:
//
// - PLAN.md §13i: the surface's own awareness object, so every
//   LiveAnnotationComposer on the page publishes "who's currently composing
//   an annotation" into one reader-facing channel rather than one per
//   annotation. Null until the surface's provider exists — and on the PDF
//   viewer, null for good, since its presence hook never sets it.
// - The one websocket every provider on the page attaches to (docs/YDOC.md
//   "One socket per page"). Created lazily on first request, because an
//   anonymous reader of a public doc gets a 401 from the token route and
//   would otherwise hold open a socket with nothing on it — which Hocuspocus
//   times out after 30s and the client then retries forever. Destroyed with
//   the provider, after every attached provider has already been torn down.
type Ctx = {
  awareness: Awareness | null;
  setAwareness: (awareness: Awareness | null) => void;
  /** The page's shared socket, created on first call. Effects only — never during render. */
  getSocket: () => CollabSocket;
};

const DocPresenceContext = createContext<Ctx | null>(null);

export function DocPresenceProvider({ children }: { children: ReactNode }) {
  const [awareness, setAwareness] = useState<Awareness | null>(null);

  // A ref rather than state: nothing renders differently for the socket
  // existing, and a lazy `useState` initializer would run twice under
  // StrictMode and leak the first socket. The effect below is only a
  // cleanup; under StrictMode's mount/unmount/mount it destroys the socket
  // the children's first effects created, and their re-run creates the next.
  const socketRef = useRef<CollabSocket | null>(null);
  const getSocket = useCallback(() => {
    if (!socketRef.current) socketRef.current = createCollabSocket();
    return socketRef.current;
  }, []);
  useEffect(
    () => () => {
      socketRef.current?.destroy();
      socketRef.current = null;
    },
    [],
  );

  return (
    <DocPresenceContext.Provider value={{ awareness, setAwareness, getSocket }}>{children}</DocPresenceContext.Provider>
  );
}

export function useDocPresence(): Ctx {
  const ctx = useContext(DocPresenceContext);
  if (!ctx) {
    throw new Error("useDocPresence must be used within DocPresenceProvider.");
  }
  return ctx;
}
