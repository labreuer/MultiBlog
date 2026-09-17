"use client";

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import type { PendingQuoteTarget } from "@/lib/comment-quote-pending";

// PLAN.md §23h — the seam between the surfaces a reader selects text on (the
// article, any comment card) and the composer that text should land in (the
// general form, a reply form, the passage popover's form). Siblings on the
// post page, so no prop can reach across — the same reason MarginNotesProvider
// exists.
//
// Composers register under a key (`post:<id>`, `reply:<commentId>`, …) and
// mark themselves active on focus. `quoteInto` delivers to a preferred
// composer when one is named, else to the active one, else to the general
// form. A preferred composer that is not mounted yet — a reply form the card
// has to open first — gets the request queued: its owner registers an
// opener, the opener runs, and the request is delivered on registration.

export type QuoteRequest = {
  target: PendingQuoteTarget;
  /** The selected words, as selected. */
  text: string;
  /** ProseMirror offsets in the target when the selecting surface has them (the article's editor). */
  from?: number;
  to?: number;
};

export type ComposerHandle = {
  key: string;
  insertQuote: (request: QuoteRequest) => void;
};

type CommentQuoteContextValue = {
  postId: string;
  register: (handle: ComposerHandle) => () => void;
  registerOpener: (key: string, open: () => void) => () => void;
  markActive: (key: string) => void;
  quoteInto: (request: QuoteRequest, preferredKey?: string) => void;
};

const CommentQuoteContext = createContext<CommentQuoteContextValue | null>(null);

export function CommentQuoteProvider({ postId, children }: { postId: string; children: ReactNode }) {
  const composers = useRef(new Map<string, ComposerHandle>());
  const openers = useRef(new Map<string, () => void>());
  const queued = useRef(new Map<string, QuoteRequest[]>());
  const active = useRef<string | null>(null);
  const defaultKey = `post:${postId}`;

  const register = useCallback((handle: ComposerHandle) => {
    composers.current.set(handle.key, handle);
    const waiting = queued.current.get(handle.key);
    if (waiting) {
      queued.current.delete(handle.key);
      for (const request of waiting) handle.insertQuote(request);
    }
    return () => {
      if (composers.current.get(handle.key) === handle) composers.current.delete(handle.key);
      if (active.current === handle.key) active.current = null;
    };
  }, []);

  const registerOpener = useCallback((key: string, open: () => void) => {
    openers.current.set(key, open);
    return () => {
      if (openers.current.get(key) === open) openers.current.delete(key);
    };
  }, []);

  const markActive = useCallback((key: string) => {
    active.current = key;
  }, []);

  const quoteInto = useCallback(
    (request: QuoteRequest, preferredKey?: string) => {
      if (preferredKey) {
        const preferred = composers.current.get(preferredKey);
        if (preferred) {
          preferred.insertQuote(request);
          return;
        }
        const open = openers.current.get(preferredKey);
        if (open) {
          queued.current.set(preferredKey, [...(queued.current.get(preferredKey) ?? []), request]);
          open();
          return;
        }
      }
      const target =
        (active.current ? composers.current.get(active.current) : undefined) ?? composers.current.get(defaultKey);
      target?.insertQuote(request);
    },
    [defaultKey],
  );

  const value = useMemo(
    () => ({ postId, register, registerOpener, markActive, quoteInto }),
    [postId, register, registerOpener, markActive, quoteInto],
  );

  return <CommentQuoteContext.Provider value={value}>{children}</CommentQuoteContext.Provider>;
}

/** Null outside a provider — the composer then has no quote gesture, and nothing else changes. */
export function useCommentQuote(): CommentQuoteContextValue | null {
  return useContext(CommentQuoteContext);
}
