"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { mergeChipContexts } from "@/lib/entity-chips/renderings";
import type { ChipContext } from "@/lib/entity-chips/types";

// docs/ENTITY_CHIPS.md, "Chips in comments" — the records a page's
// comment bodies label their chips from. The page hands over what it loaded
// for every comment it shows; a card's saved edit, a composer's switch to
// rich text and the history panel add what they were answered with, since a
// body the page never rendered can name someone its records don't hold.
//
// Without a provider the context is empty and adding does nothing, so a body
// shown outside one renders its chips as unknown rather than failing.

type CommentChips = {
  context: ChipContext;
  add: (more: ChipContext | null | undefined) => void;
};

const NO_CHIPS: CommentChips = { context: {}, add: () => {} };

const CommentChipsContext = createContext<CommentChips>(NO_CHIPS);

export function CommentChipsProvider({ context, children }: { context: ChipContext; children: ReactNode }) {
  const [added, setAdded] = useState<ChipContext>({});
  const add = useCallback((more: ChipContext | null | undefined) => {
    if (!more || Object.keys(more).length === 0) return;
    setAdded((previous) => mergeChipContexts(previous, more));
  }, []);
  // What was added is the fresher answer, so it wins over the page's.
  const value = useMemo(() => ({ context: mergeChipContexts(context, added), add }), [context, added, add]);
  return <CommentChipsContext.Provider value={value}>{children}</CommentChipsContext.Provider>;
}

export function useCommentChips(): CommentChips {
  return useContext(CommentChipsContext);
}
