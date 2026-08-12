"use client";

import { useState, type CSSProperties } from "react";
import type { ThreadStatus } from "@/generated/prisma/enums";
import styles from "./QuoteThreadHeader.module.css";

const BORDER_WIDTH = 3;
const HEAD_WIDTH = 11;
const HEAD_HEIGHT = 6;

type Props = {
  threadId: string;
  quotedText: string;
  status: ThreadStatus;
  context: string | null;
  color: string;
};

export default function QuoteThreadHeader({ threadId, quotedText, status, context, color }: Props) {
  const [showContext, setShowContext] = useState(false);
  const detached = status === "DETACHED";

  const jumpToQuote = () => {
    // Shared by both reading surfaces (comments and annotations), which
    // anchor their quoted range in the article differently: a post's quote
    // is a decoration, tagged data-thread-ids (~= word-match, since
    // overlapping quotes get split into shared segments carrying every
    // thread ID that applies — see quote-highlight-extension); a doc's
    // annotation is a mark in the document itself, tagged data-annotation-id
    // (exact match — a mark never merges several ids onto one span the way a
    // decoration segment does), keyed by the thread's own id (the root
    // annotation's id — see getDocAnnotationsAsThreads). One querySelectorAll
    // covers both since a given page only ever renders one kind.
    const targets = document.querySelectorAll<HTMLElement>(
      `[data-thread-ids~="${threadId}"], [data-annotation-id="${threadId}"]`,
    );
    if (targets.length === 0) {
      return;
    }
    targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
    targets.forEach((el) => {
      el.classList.add("pulse");
      window.setTimeout(() => el.classList.remove("pulse"), 1200);
    });
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.row}>
        <div
          onClick={detached ? () => setShowContext((v) => !v) : jumpToQuote}
          role="button"
          aria-label={detached ? "Show where this quote used to appear" : "Jump to quoted text in the article"}
          className={styles.markerColumn}
          style={detached ? { width: HEAD_WIDTH } : ({ width: HEAD_WIDTH, "--thread-color": color } as CSSProperties)}
        >
          <svg
            width={HEAD_WIDTH}
            height={HEAD_HEIGHT}
            viewBox={`0 0 ${HEAD_WIDTH} ${HEAD_HEIGHT}`}
            className={styles.arrow}
          >
            <path
              d={`M${HEAD_WIDTH / 2} 0 L${HEAD_WIDTH} ${HEAD_HEIGHT} L0 ${HEAD_HEIGHT} Z`}
              className={detached ? styles.arrowDetached : styles.arrowActive}
            />
          </svg>
          <div
            className={`${styles.bar} ${detached ? styles.barDetached : styles.barActive}`}
            style={{ width: BORDER_WIDTH }}
          />
        </div>
        <blockquote className={`${styles.quote} ${detached ? styles.quoteDetached : styles.quoteActive}`}>
          {quotedText}
        </blockquote>
      </div>
      {/* Per PLAN.md §5: a detached thread (its quote was edited or removed
          in a later revision) loses the inline indicator but stays listed,
          with a notice and a way to see the quote in its original context. */}
      {detached && (
        <p className={styles.detachedNotice}>
          This quote was edited or removed in a later revision of the article.{" "}
          <button type="button" onClick={() => setShowContext((v) => !v)} className={styles.contextToggle}>
            {showContext ? "Hide" : "Show"} where it used to appear
          </button>
        </p>
      )}
      {detached && showContext && <p className={styles.contextText}>{context ?? "No longer available."}</p>}
    </div>
  );
}
