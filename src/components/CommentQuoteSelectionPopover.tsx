"use client";

import { useEffect, useRef, useState } from "react";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useCommentQuote } from "./comment-quote-context";
import styles from "./CommentQuoteSelectionPopover.module.css";

// PLAN.md §23h — "Quote in reply": selecting text inside a comment card
// offers to quote it into a reply to that comment. One listener for the
// whole page rather than one per card — the selection's anchor node says
// which card it is in.
//
// The selection settles on `selectionchange`, debounced, with `pointerup`
// short-circuiting it (CLAUDE.md's rule, and its reason: shift+arrows
// delivers no pointer event anywhere). The button is placed by floating-ui
// from a virtual element over the selection's last rect, `position: fixed`,
// which is the one arrangement CLAUDE.md says needs no hand clamping.

const SETTLE_MS = 200;

type Pending = {
  commentId: string;
  text: string;
  rect: DOMRect;
};

function selectionInCard(): Pending | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const body = element?.closest<HTMLElement>("[data-comment-body]");
  if (!body) return null;
  // A selection that starts in a composer (a textarea, a contenteditable) is
  // typing, not quoting.
  if (element?.closest("textarea, [contenteditable=true]")) return null;
  const card = body.closest<HTMLElement>("[data-comment-id]");
  const commentId = card?.dataset.commentId;
  if (!commentId) return null;
  const rects = range.getClientRects();
  const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
  return { commentId, text, rect };
}

export default function CommentQuoteSelectionPopover() {
  const quote = useCommentQuote();
  const [pending, setPending] = useState<Pending | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!quote) return;
    let timer: number | null = null;
    const settle = () => {
      timer = null;
      setPending(selectionInCard());
    };
    const onSelectionChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE_MS);
    };
    const onPointerUp = () => {
      if (timer !== null) window.clearTimeout(timer);
      // The pointer's own selection update can land a tick later.
      timer = window.setTimeout(settle, 0);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onPointerUp);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [quote]);

  useEffect(() => {
    const button = buttonRef.current;
    if (!pending || !button) return;
    const reference = { getBoundingClientRect: () => pending.rect };
    const place = () => {
      computePosition(reference, button, {
        strategy: "fixed",
        placement: "bottom-end",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        button.style.left = `${x}px`;
        button.style.top = `${y}px`;
      });
    };
    return autoUpdate(reference, button, place);
  }, [pending]);

  if (!quote || !pending) return null;

  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.button}
      data-testid="quote-in-reply"
      // mousedown, not click: a click first collapses the selection, and
      // then there is nothing to quote.
      onMouseDown={(event) => {
        event.preventDefault();
        quote.quoteInto({ target: { kind: "comment", id: pending.commentId }, text: pending.text }, `reply:${pending.commentId}`);
        window.getSelection()?.removeAllRanges();
        setPending(null);
      }}
    >
      Quote in reply
    </button>
  );
}
