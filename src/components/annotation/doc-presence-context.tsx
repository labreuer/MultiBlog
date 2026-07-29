"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

// The Awareness class itself lives in y-protocols, a transitive dependency
// (not declared directly in package.json) — HocuspocusProvider's own
// `.awareness` property type is what's actually stable to depend on here,
// so this reads it off that instead of importing y-protocols/awareness
// directly, same as the rest of this codebase never does either.
type Awareness = HocuspocusProvider["awareness"];

// PLAN.md §13i — exposes the doc reading view's own awareness object
// (LiveDocBody's read-only Hocuspocus connection) to the annotation tree,
// which is a sibling in page.tsx, not a child — same cross-tree problem
// AnnotationMoveProvider already solves for "Move to bottom", solved the
// same way here for a different signal: "who's currently composing an
// annotation." A single reader-facing awareness channel, not one per
// annotation — every LiveAnnotationComposer instance on the page publishes
// into this same object, keyed by its own client id.
type Ctx = { awareness: Awareness | null; setAwareness: (awareness: Awareness | null) => void };

const DocPresenceContext = createContext<Ctx | null>(null);

export function DocPresenceProvider({ children }: { children: ReactNode }) {
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  return <DocPresenceContext.Provider value={{ awareness, setAwareness }}>{children}</DocPresenceContext.Provider>;
}

export function useDocPresence(): Ctx {
  const ctx = useContext(DocPresenceContext);
  if (!ctx) {
    throw new Error("useDocPresence must be used within DocPresenceProvider.");
  }
  return ctx;
}
