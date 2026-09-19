"use client";

import { NEUTRAL_THREAD_COLOR } from "./author-colors";

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

// Two positioned containers can hold comment/annotation cards now: the
// section at the bottom of the article, and the margin-notes rail beside it
// (PLAN.md §18), which anchored cards are portaled into. A bar has to be
// placed inside whichever one actually holds its target — placing every bar
// in the section would leave the rail's cards marked in the wrong column, at
// an offset measured against a container they aren't in.
const ROOT_SELECTOR = "[data-comment-section], [data-pseudo-border-root]";

// What the page is currently marking, kept as *data* rather than as a
// reference to the element that was marked. The two roots above sit on
// opposite sides of a `createPortal` boundary, so a card moving between the
// section and the rail is unmounted from one and mounted into the other — its
// DOM node is replaced at exactly the moment the bar needs re-placing, which
// makes a remembered element detached precisely when it would be needed. An
// id survives the move; re-finding it costs one `getElementById`.
type Activation =
  | { kind: "hash"; hash: string }
  | { kind: "thread"; threadId: string; color: string };

let activation: Activation | null = null;

function rootFor(target: HTMLElement): HTMLElement | null {
  return target.closest<HTMLElement>(ROOT_SELECTOR);
}

function placeBorder(target: HTMLElement, color: string) {
  const root = rootFor(target);
  if (!root) return;
  const rootRect = root.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const bar = document.createElement("div");
  bar.dataset.pseudoBorder = "true";
  Object.assign(bar.style, {
    position: "absolute",
    left: `${-(BAR_WIDTH + GAP)}px`,
    top: `${targetRect.top - rootRect.top}px`,
    width: `${BAR_WIDTH}px`,
    height: `${targetRect.height}px`,
    backgroundColor: color,
    pointerEvents: "none",
  });
  root.appendChild(bar);
}

// Document-wide rather than scoped to one root: a bar can now live in either
// container, and "clear" has always meant "there is at most one activation on
// the page at a time".
export function clearPseudoBorders() {
  activation = null;
  document.querySelectorAll<HTMLElement>("[data-pseudo-border]").forEach((el) => el.remove());
}

// Fires from an inline quote bubble click, alongside the existing flash —
// one bar per matching comment entry's root comment (a thread can have more
// than one root if separate people commented on the same quote without
// replying to each other).
export function activatePseudoBordersForThread(threadId: string, color: string) {
  clearPseudoBorders();
  activation = { kind: "thread", threadId, color };
  document.querySelectorAll<HTMLElement>(`[data-thread-id="${threadId}"]`).forEach((entry) => {
    // First [data-comment-id] in document order is always the entry's own
    // root comment div, since replies are appended after it in the DOM.
    const commentDiv = entry.querySelector<HTMLElement>("[data-comment-id]");
    if (commentDiv) placeBorder(commentDiv, color);
  });
}

// Mirrors the current URL hash (a comment timestamp permalink) to a single
// pseudo-border. Pass "" to just clear.
export function activatePseudoBorderForHash(hash: string) {
  clearPseudoBorders();
  if (!hash) return;
  activation = { kind: "hash", hash };
  const anchor = document.getElementById(hash);
  const commentDiv = anchor?.closest<HTMLElement>("[data-comment-id]");
  if (!commentDiv) return;
  const color = commentDiv.closest<HTMLElement>("[data-thread-id]")?.dataset.threadColor ?? NEUTRAL_THREAD_COLOR;
  placeBorder(commentDiv, color);
}

// Re-place whatever is currently marked, against wherever its card is *now*.
//
// A bar is positioned imperatively, so it goes stale for every reason a card
// moves — and the first of these was silently wrong for as long as the rail
// existed:
//
//   - The rail claiming the card. Both reading views paint their first client
//     render with every card in the section below, because `anchored` needs a
//     mounted editor to measure and TipTap's is `immediatelyRender: false`.
//     The hash effect runs there, so the bar was appended to the section at
//     the card's stacked-layout offset; the card then portaled up into the
//     rail and the bar stayed behind, stranded at the bottom of the page.
//   - The rail repacking, when a neighbour above grows and pushes this card
//     down.
//   - A viewport narrowed back across the breakpoint, which removes the rail
//     container — and with it any bar appended to it — while the cards return
//     to the section.
//   - The marked card changing height, since the bar's height is the card's.
//
// `useMarginNotesLayout` already knows when every one of those happens, and
// reports them through `onLayout`; this is what it calls. Cheap when nothing
// is marked, which is the ordinary case — a page marks something only after a
// permalink or a quote-bubble click.
export function refreshPseudoBorders() {
  const current = activation;
  if (!current) return;
  if (current.kind === "hash") {
    activatePseudoBorderForHash(current.hash);
  } else {
    activatePseudoBordersForThread(current.threadId, current.color);
  }
}
