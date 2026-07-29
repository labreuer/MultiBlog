"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// PLAN.md §13g — "Move to bottom" re-targets which composer slot renders an
// already-created draft; it never copies content (the ydoc is the content,
// and both slots would just be different connections to the same one). The
// inline popover (LiveDocBody's tree) and the bottom composer
// (AnnotationSection's tree) are siblings in page.tsx, not parent/child, so
// handing a draft id across that boundary needs a context provider wrapping
// both rather than a prop.
export type MovedDraft = { id: string; anchorFrom?: number; anchorTo?: number; quotedText?: string };

type Ctx = { movedDraft: MovedDraft | null; setMovedDraft: (draft: MovedDraft | null) => void };

const AnnotationMoveContext = createContext<Ctx | null>(null);

export function AnnotationMoveProvider({ children }: { children: ReactNode }) {
  const [movedDraft, setMovedDraft] = useState<MovedDraft | null>(null);
  return <AnnotationMoveContext.Provider value={{ movedDraft, setMovedDraft }}>{children}</AnnotationMoveContext.Provider>;
}

export function useAnnotationMove(): Ctx {
  const ctx = useContext(AnnotationMoveContext);
  if (!ctx) {
    throw new Error("useAnnotationMove must be used within AnnotationMoveProvider.");
  }
  return ctx;
}
