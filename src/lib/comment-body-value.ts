import type { JSONContent } from "@tiptap/core";
import type { PendingQuoteHint } from "./comment-quote-pending";

// PLAN.md §23m — the composer's value, in either of its two modes, and the
// wire shape the server actions take. Browser-safe on purpose: the form, the
// inline editor and the draft store all import this; the parse itself
// (comment-body-resolve.ts) pulls in the Markdown parser and stays on the
// server.

export type CommentBodyMode = "markdown" | "rich";

export type CommentBodyValue =
  // `pending` here is unbound (PLAN.md §23h, Phase 4): the off-page picker
  // names a target to search, and a `> ` block in the text is what is found.
  | { mode: "markdown"; markdown: string; pending?: PendingQuoteHint[] }
  // `json` is null while the editor is empty, so "is there anything to post"
  // is one check in either mode. `pending` (PLAN.md §23g) is what the body's
  // placeholder anchor ids point at — the rich composer's quote gesture; the
  // Markdown box has no equivalent, the matcher finds its quotes from text.
  | { mode: "rich"; json: JSONContent | null; pending?: PendingQuoteHint[] };

/**
 * What crosses the action boundary. The rich body travels as a JSON *string*
 * rather than an object: `editor.getJSON()` carries null-prototype `attrs`
 * objects that React's server-action encoder replaces with an inert
 * placeholder (tiptap-schema.ts's `toPlainJSON` comment), and stringifying
 * is the one step that cannot forget to happen.
 */
export type CommentBodyInput = { format: CommentBodyMode; content: string };

export function emptyCommentBodyValue(mode: CommentBodyMode): CommentBodyValue {
  return mode === "markdown" ? { mode, markdown: "" } : { mode, json: null };
}

export function isCommentBodyValueEmpty(value: CommentBodyValue): boolean {
  return value.mode === "markdown" ? value.markdown.trim() === "" : value.json === null;
}

export function commentBodyValueToInput(value: CommentBodyValue): CommentBodyInput {
  return value.mode === "markdown"
    ? { format: "markdown", content: value.markdown }
    : { format: "rich", content: value.json ? JSON.stringify(value.json) : "" };
}

/** The pending hints as the wire carries them — a JSON string, "" when there are none. */
export function commentBodyValuePendingJSON(value: CommentBodyValue): string {
  return value.pending && value.pending.length > 0 ? JSON.stringify(value.pending) : "";
}

// The mode a browser last chose, remembered per browser like the annotation
// toolbar's visibility. Markdown is the default: it is the textarea the form
// always had, and the ask (§23m) was for it to stay available.
const MODE_STORAGE_KEY = "multiblog.commentMode";

export function rememberedCommentBodyMode(): CommentBodyMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "rich" ? "rich" : "markdown";
  } catch {
    return "markdown";
  }
}

export function rememberCommentBodyMode(mode: CommentBodyMode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // A browser that blocks storage just doesn't remember; nothing else changes.
  }
}
