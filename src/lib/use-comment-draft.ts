"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
    ? { mode: "markdown", markdown: draft.markdown }
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
  const loaded = useRef(false);
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
      loaded.current = true;
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
    if (!enabled || !loaded.current) return;
    const timer = window.setTimeout(() => {
      if (isCommentBodyValueEmpty(value)) {
        void deleteCommentDraft(key);
      } else {
        void saveCommentDraft(
          value.mode === "markdown"
            ? { key, mode: "markdown", markdown: value.markdown, json: null }
            : { key, mode: "rich", markdown: "", json: value.json, pending: value.pending ?? [] },
        );
      }
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, value, enabled]);

  const clear = useCallback(() => {
    setRestored(false);
    void deleteCommentDraft(key);
  }, [key]);

  const discard = useCallback(() => {
    clear();
    setValue(valueRef.current.mode === "markdown" ? { mode: "markdown", markdown: "" } : { mode: "rich", json: null });
  }, [clear, setValue]);

  return { restored, discard, clear };
}
