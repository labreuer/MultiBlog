"use client";

// A persistent colored bar standing in for a `border-left` that can't be
// drawn on the target comment's own div — the design puts it in the margin
// to the left of the whole comment <section> instead, still vertically
// aligned to that div's top/height, so it reads as "this comment's border,
// relocated" rather than a border on the section itself. Unlike the
// existing flash/pulse effects (AnnotatableArticle's flashHighlight,
// QuoteThreadHeader's jumpToQuote), it never animates or clears itself —
// only the next activate/clear call touches it.
const BAR_WIDTH = 2;
const GAP = 2;

function getSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-comment-section]");
}

function placeBorder(section: HTMLElement, target: HTMLElement, color: string) {
  const sectionRect = section.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const bar = document.createElement("div");
  bar.dataset.pseudoBorder = "true";
  Object.assign(bar.style, {
    position: "absolute",
    left: `${-(BAR_WIDTH + GAP)}px`,
    top: `${targetRect.top - sectionRect.top}px`,
    width: `${BAR_WIDTH}px`,
    height: `${targetRect.height}px`,
    backgroundColor: color,
    pointerEvents: "none",
  });
  section.appendChild(bar);
}

export function clearPseudoBorders() {
  getSection()
    ?.querySelectorAll<HTMLElement>("[data-pseudo-border]")
    .forEach((el) => el.remove());
}

// Fires from an inline quote bubble click, alongside the existing flash —
// one bar per matching comment entry's root comment (a thread can have more
// than one root if separate people commented on the same quote without
// replying to each other).
export function activatePseudoBordersForThread(threadId: string, color: string) {
  const section = getSection();
  if (!section) return;
  clearPseudoBorders();
  document.querySelectorAll<HTMLElement>(`[data-thread-id="${threadId}"]`).forEach((entry) => {
    // First [data-comment-id] in document order is always the entry's own
    // root comment div, since replies are appended after it in the DOM.
    const commentDiv = entry.querySelector<HTMLElement>("[data-comment-id]");
    if (commentDiv) placeBorder(section, commentDiv, color);
  });
}

// Mirrors the current URL hash (a comment timestamp permalink) to a single
// pseudo-border. Pass "" to just clear.
export function activatePseudoBorderForHash(hash: string) {
  const section = getSection();
  if (!section) return;
  clearPseudoBorders();
  if (!hash) return;
  const anchor = document.getElementById(hash);
  const commentDiv = anchor?.closest<HTMLElement>("[data-comment-id]");
  if (!commentDiv) return;
  const color = commentDiv.closest<HTMLElement>("[data-thread-id]")?.dataset.threadColor ?? "#999";
  placeBorder(section, commentDiv, color);
}
