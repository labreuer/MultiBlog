import {
  MAX_COMMENT_CHARS,
  MAX_COMMENT_JSON_CHARS,
  MAX_COMMENT_MARKDOWN_CHARS,
  parseCommentBody,
  type CommentBodyError,
  type ParsedCommentBody,
} from "./comment-body";
import type { CommentBodyInput } from "./comment-body-value";
import { markdownToCommentContent } from "./markdown-import";

// PLAN.md §23m — the one write path's two front doors, converging.
//
// Server-side (it imports the Markdown parser), and the only function a
// comment action calls to turn what a client sent into what gets stored. A
// Markdown source is parsed through the conform pass first; a rich body is
// the editor's JSON, decoded from the string it travelled as. Both then go
// through `parseCommentBody`, so the schema, the caps and the link hardening
// apply identically whichever door the body came through.
export function resolveCommentBody(input: CommentBodyInput): ParsedCommentBody | CommentBodyError {
  if (input.format === "markdown") {
    if (!input.content.trim()) return { error: "Comment can't be empty." };
    // A cap on the *source* so a megabyte never reaches the parser; the cap
    // that matters is parseCommentBody's, on the resulting text.
    if (input.content.length > MAX_COMMENT_MARKDOWN_CHARS) {
      return { error: `Comment is too long (max ${MAX_COMMENT_CHARS} characters).` };
    }
    return parseCommentBody(markdownToCommentContent(input.content));
  }

  if (!input.content.trim()) return { error: "Comment can't be empty." };
  if (input.content.length > MAX_COMMENT_JSON_CHARS) {
    return { error: `Comment is too long (max ${MAX_COMMENT_CHARS} characters).` };
  }
  let json: unknown;
  try {
    json = JSON.parse(input.content);
  } catch {
    return { error: "Malformed comment." };
  }
  return parseCommentBody(json);
}
