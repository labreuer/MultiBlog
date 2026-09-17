"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteCommentDraft,
  loadCommentDraft,
  pruneCommentDrafts,
  saveCommentDraft,
  type CommentDraft,
} from "./comment-draft-store";
import { isCommentBodyValueEmpty, type CommentBodyValue } from "./comment-body-value";

const SAVE_DEBOUNCE_MS = 500;

function draftToValue(draft: CommentDraft): CommentBodyValue {
  return draft.mode === "markdown"
    ? { mode: "markdown", markdown: draft.markdown, pending: draft.pending ?? [] }
    : { mode: "rich", json: draft.json, pending: draft.pending ?? [] };
}

/**
 * PLAN.md §23g — keeps one composer's unsent value in IndexedDB.
 *
 * On mount: prune old drafts, then restore this key's if the composer is
 * still empty — silently, plus `restored` so the form can show "Draft
 * restored · discard", because a silently restored paragraph the author had
 * forgotten is how a stale comment gets posted. Every change is saved after
 * a short debounce; an emptied composer deletes its draft rather than saving
 * an empty one. `clear()` is for the moment the comment is posted.
 *
 * `enabled: false` (an edit box, which is not an unsent comment) makes the
 * hook inert without a second code path in the caller.
 */
export function useCommentDraft(
  key: string,
  value: CommentBodyValue,
  setValue: (value: CommentBodyValue) => void,
  enabled = true,
): { restored: boolean; discard: () => void; clear: () => void } {
  const [restored, setRestored] = useState(false);
  // Whether the mount-time restore has run; saves before it would race it.
  //
  // **State rather than a ref, and that is the whole of a second bug.** The
  // save below runs on value changes, so a body typed *before* IndexedDB
  // answered found the gate shut and was never saved: setting a ref
  // re-renders nothing, so the effect had no reason to run again, and the
  // text sat there until the next keystroke — or forever, for a body that
  // arrived in one change (a paste, a restored quote, `fill()` in a test).
  // The one thing that makes the gate opening visible to an effect is a
  // dependency, which a ref cannot be.
  const [loaded, setLoaded] = useState(false);
  // The debounced save in flight, and whether this composer has been cleared.
  // Both exist for the same moment: posting. A submission changes the value
  // one last time — the rich composer's `disabled` flip reaches TipTap as
  // `setEditable`, which emits an `update` unasked — so a save is scheduled
  // *just* before the action returns, and `clear()`'s delete then lands
  // between that schedule and its write. The draft came back ~400ms after
  // being deleted, and the author's next visit was greeted with "Draft
  // restored" for the comment they had already posted. Cancelling the timer
  // handles the save already scheduled; the flag handles any scheduled after,
  // since a posted composer never accepts another keystroke. `discard()`
  // clears too, but its own `setValue` to an empty body lifts the flag below,
  // so a composer the author emptied by hand goes on saving normally.
  const timer = useRef<number | null>(null);
  const cleared = useRef(false);
  // The latest value, for the two callbacks below that must read it after an
  // await or from a stable identity. Synced in an effect (never during
  // render), declared first so it runs before the restore effect's.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      await pruneCommentDrafts();
      const draft = await loadCommentDraft(key);
      if (cancelled) return;
      setLoaded(true);
      if (draft && isCommentBodyValueEmpty(valueRef.current) && !isCommentBodyValueEmpty(draftToValue(draft))) {
        setValue(draftToValue(draft));
        setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The key names the composer; a different key is a different draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  useEffect(() => {
    if (!enabled || !loaded) return;
    if (isCommentBodyValueEmpty(value)) cleared.current = false;
    if (cleared.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (isCommentBodyValueEmpty(value)) {
        void deleteCommentDraft(key);
      } else {
        void saveCommentDraft(
          value.mode === "markdown"
            ? { key, mode: "markdown", markdown: value.markdown, json: null, pending: value.pending ?? [] }
            : { key, mode: "rich", markdown: "", json: value.json, pending: value.pending ?? [] },
        );
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    // `loaded` earns its place here: the run it triggers is the one that
    // saves whatever was typed while the load was still in flight.
  }, [key, value, enabled, loaded]);

  const clear = useCallback(() => {
    cleared.current = true;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setRestored(false);
    void deleteCommentDraft(key);
  }, [key]);

  const discard = useCallback(() => {
    clear();
    setValue(valueRef.current.mode === "markdown" ? { mode: "markdown", markdown: "" } : { mode: "rich", json: null });
  }, [clear, setValue]);

  // A stable object, so a caller may list it as an effect dependency. A
  // fresh literal here once re-fired CommentForm's post-approval effect on
  // every render, and that effect calls `router.refresh()`.
  return useMemo(() => ({ restored, discard, clear }), [restored, discard, clear]);
}
