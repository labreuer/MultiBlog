"use client";

const BORDER_COLOR = "#d4a017";
const BORDER_WIDTH = 3;
const HEAD_WIDTH = 10;
const HEAD_HEIGHT = 6;

type Props = {
  threadId: string;
  quotedText: string;
};

export default function QuoteThreadHeader({ threadId, quotedText }: Props) {
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
    // No CSS border anywhere — a border and an SVG fill of the "same" color
    // don't reliably rasterize to the same pixels (borders have their own
    // anti-aliasing/snapping path), which is what was still visible before.
    // The arrowhead (fixed-size SVG) and the line below it (a plain
    // background-color div) are both solid fills instead, and flexbox
    // stretches the line to the blockquote's actual height — no JS
    // measurement, no position: absolute.
    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
      <div
        onClick={jumpToQuote}
        role="button"
        aria-label="Jump to quoted text in the article"
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
          <path d={`M${HEAD_WIDTH / 2} 0 L${HEAD_WIDTH} ${HEAD_HEIGHT} L0 ${HEAD_HEIGHT} Z`} fill={BORDER_COLOR} />
        </svg>
        <div style={{ width: BORDER_WIDTH, flex: 1, backgroundColor: BORDER_COLOR }} />
      </div>
      <blockquote
        style={{
          margin: 0,
          fontSize: "0.85rem",
          color: "#555",
          fontStyle: "italic",
        }}
      >
        {quotedText}
      </blockquote>
    </div>
  );
}
