"use client";

import { useState } from "react";
import type { ThreadStatus } from "@/generated/prisma/enums";

const BORDER_COLOR = "#d4a017";
const DETACHED_COLOR = "#999";
const BORDER_WIDTH = 3;
const HEAD_WIDTH = 10;
const HEAD_HEIGHT = 6;

type Props = {
  threadId: string;
  quotedText: string;
  status: ThreadStatus;
  context: string | null;
};

export default function QuoteThreadHeader({ threadId, quotedText, status, context }: Props) {
  const [showContext, setShowContext] = useState(false);
  const detached = status === "DETACHED";
  const color = detached ? DETACHED_COLOR : BORDER_COLOR;

  const jumpToQuote = () => {
    // ~= matches one word in a space-separated attribute value — needed
    // since overlapping quotes get split into shared segments tagged with
    // every thread ID that applies to them (see quote-highlight-extension).
    const targets = document.querySelectorAll<HTMLElement>(`[data-thread-ids~="${threadId}"]`);
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
    <div style={{ marginBottom: 8 }}>
      {/* No CSS border anywhere — a border and an SVG fill of the "same"
          color don't reliably rasterize to the same pixels. The arrowhead
          (fixed-size SVG) and the line below it (a plain background-color
          div) are both solid fills instead, and flexbox stretches the line
          to the blockquote's actual height — no JS measurement. */}
      <div style={{ display: "flex", gap: 8 }}>
        <div
          onClick={detached ? () => setShowContext((v) => !v) : jumpToQuote}
          role="button"
          aria-label={detached ? "Show where this quote used to appear" : "Jump to quoted text in the article"}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: HEAD_WIDTH,
            flexShrink: 0,
            cursor: "pointer",
          }}
        >
          <svg
            width={HEAD_WIDTH}
            height={HEAD_HEIGHT}
            viewBox={`0 0 ${HEAD_WIDTH} ${HEAD_HEIGHT}`}
            style={{ display: "block", flexShrink: 0 }}
          >
            <path d={`M${HEAD_WIDTH / 2} 0 L${HEAD_WIDTH} ${HEAD_HEIGHT} L0 ${HEAD_HEIGHT} Z`} fill={color} />
          </svg>
          <div style={{ width: BORDER_WIDTH, flex: 1, backgroundColor: color }} />
        </div>
        <blockquote
          style={{
            margin: 0,
            fontSize: "0.85rem",
            color: detached ? "#777" : "#555",
            fontStyle: "italic",
          }}
        >
          {quotedText}
        </blockquote>
      </div>
      {/* Per PLAN.md §5: a detached thread (its quote was edited or removed
          in a later revision) loses the inline indicator but stays listed,
          with a notice and a way to see the quote in its original context. */}
      {detached && (
        <p style={{ fontSize: "0.78rem", color: "#999", margin: "2px 0 0 18px" }}>
          This quote was edited or removed in a later revision of the article.{" "}
          <button
            type="button"
            onClick={() => setShowContext((v) => !v)}
            style={{
              font: "inherit",
              color: "#777",
              background: "none",
              border: "none",
              padding: 0,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            {showContext ? "Hide" : "Show"} where it used to appear
          </button>
        </p>
      )}
      {detached && showContext && (
        <p style={{ fontSize: "0.8rem", color: "#666", margin: "4px 0 0 18px", fontStyle: "italic" }}>
          {context ?? "No longer available."}
        </p>
      )}
    </div>
  );
}
