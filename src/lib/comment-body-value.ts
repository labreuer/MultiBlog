import type { JSONContent } from "@tiptap/core";

// PLAN.md §23m — the composer's value, in either of its two modes, and the
// wire shape the server actions take. Browser-safe on purpose: the form, the
// inline editor and the draft store all import this; the parse itself
// (comment-body-resolve.ts) pulls in the Markdown parser and stays on the
// server.

export type CommentBodyMode = "markdown" | "rich";

export type CommentBodyValue =
  | { mode: "markdown"; markdown: string }
  // `json` is null while the editor is empty, so "is there anything to post"
  // is one check in either mode.
  | { mode: "rich"; json: JSONContent | null };

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
