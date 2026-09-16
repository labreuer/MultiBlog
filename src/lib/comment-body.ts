import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { COMMENT_LINK_REL, COMMENT_LINK_TARGET, pmCommentContentSchema, toPlainJSON } from "./tiptap-schema";

// PLAN.md §23b — a comment body as a validated ProseMirror document, and the
// one place the write-side rules for it live. Browser-safe (no Prisma, no
// markdown parser): the rich composer imports the schema beside it, the
// server action imports the validation, and the e2e fixtures import the
// text → document helper so they seed what the app would have written.
//
// **The schema is the validation.** `pmCommentContentSchema.nodeFromJSON`
// throws on any node or mark it does not define, and `node.check()` rejects a
// tree the content expressions do not allow — so there is never HTML to
// sanitize and no allowlist to keep in step with the editor. What is added on
// top is the two caps §23b asks for, and link hardening, which the schema
// cannot express because it is a rule about attribute *values*.

/** The longest plain text a comment may carry — the old textarea's maxLength. */
export const MAX_COMMENT_CHARS = 5000;

/**
 * How much Markdown source is worth parsing at all. Above the text cap by a
 * margin for syntax (`**`, `> `, list markers) but not by much: the cap on the
 * result is what matters, this one just keeps a megabyte out of the parser.
 */
export const MAX_COMMENT_MARKDOWN_CHARS = 8000;

/**
 * The same for a rich body's JSON string, which is a good deal bigger than
 * its text — every paragraph is a node, every mark a small object.
 */
export const MAX_COMMENT_JSON_CHARS = 60_000;

/**
 * How deep a comment's tree may go. A document is a tree and a stranger's tree
 * can be deep — `> > > > > >` and indented lists nest without limit from a
 * textarea. Six is a blockquote inside a list inside a blockquote with room to
 * spare; nothing legitimate reaches it.
 */
export const MAX_COMMENT_DEPTH = 6;

export type ParsedCommentBody = {
  /** The validated node, for anything that wants positions. */
  node: PMNode;
  /** The canonical JSON to store — `node.toJSON()`, plain-prototyped. */
  json: JSONContent;
  /** `commentBodyText(node)`, for `body_text`, the spam check and excerpts. */
  text: string;
};

export type CommentBodyError = { error: string };

export function isCommentBodyError(value: ParsedCommentBody | CommentBodyError): value is CommentBodyError {
  return "error" in value;
}

/**
 * The plain text of a comment body: textblocks joined by newlines, a hard
 * break as a newline, trimmed. What `Comment.bodyText` holds, and what the
 * migration derived for every backfilled row — one line per paragraph — so
 * the two agree by construction.
 */
export function commentBodyText(node: PMNode): string {
  return node.textBetween(0, node.content.size, "\n", "\n").trim();
}

/** `commentBodyText` for a stored JSON body; "" for anything that won't parse. */
export function commentBodyTextFromJSON(json: unknown): string {
  try {
    return commentBodyText(pmCommentContentSchema.nodeFromJSON(json as JSONContent));
  } catch {
    return "";
  }
}

/**
 * Plain text → a comment document: one paragraph per non-empty line. The
 * shape the rich_comment_bodies migration gave every pre-§23 body, restated
 * in TypeScript for the fixtures and seed scripts that insert comments
 * directly, so they write what the migration would have.
 */
export function commentDocFromText(text: string): JSONContent {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return {
    type: "doc",
    content:
      lines.length === 0
        ? [{ type: "paragraph" }]
        : lines.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** True for an href a comment may carry. Relative and protocol-less URLs are refused too. */
export function isAllowedCommentHref(href: unknown): href is string {
  if (typeof href !== "string" || !href.trim()) return false;
  try {
    return LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/**
 * Every link mark gets `rel="nofollow noopener"` and `target="_blank"` on the
 * stored mark itself, and a link whose href is not http, https or mailto is
 * dropped — the text stays. `Link.configure`'s HTMLAttributes already cover
 * the renderer; doing it on the data too means a mark that arrives with its
 * own `rel` (the JSON is client-supplied) cannot override the renderer's
 * default, and a reader of the column sees the rule rather than having to
 * know about the renderer.
 */
export function hardenCommentLinks(json: JSONContent): JSONContent {
  function walk(node: JSONContent): JSONContent {
    let out = node;
    if (node.marks?.some((mark) => mark.type === "link")) {
      const marks = node.marks.flatMap((mark) => {
        if (mark.type !== "link") return [mark];
        const href = mark.attrs?.href;
        if (!isAllowedCommentHref(href)) return [];
        return [{ type: "link", attrs: { href, rel: COMMENT_LINK_REL, target: COMMENT_LINK_TARGET } }];
      });
      out = { ...out, marks };
      if (marks.length === 0) {
        const { marks: _dropped, ...rest } = out;
        void _dropped;
        out = rest;
      }
    }
    if (node.content) {
      out = { ...out, content: node.content.map(walk) };
    }
    return out;
  }
  return walk(json);
}

/** The depth of the deepest node — a bare `doc` is 1, a paragraph in it 2. */
export function commentDocDepth(json: JSONContent): number {
  let deepest = 0;
  function walk(node: JSONContent, depth: number) {
    if (depth > deepest) deepest = depth;
    node.content?.forEach((child) => walk(child, depth + 1));
  }
  walk(json, 1);
  return deepest;
}

/**
 * Validates a client-supplied document and returns the canonical form to
 * store, or the message to show. Every path that writes `Comment.body` goes
 * through here — the rich composer's JSON directly, the Markdown box via
 * `markdownToCommentContent` first.
 */
export function parseCommentBody(input: unknown): ParsedCommentBody | CommentBodyError {
  if (!input || typeof input !== "object" || (input as JSONContent).type !== "doc") {
    return { error: "Malformed comment." };
  }
  const json = input as JSONContent;
  if (commentDocDepth(json) > MAX_COMMENT_DEPTH) {
    return { error: "Comment is nested too deeply." };
  }

  let node: PMNode;
  try {
    node = pmCommentContentSchema.nodeFromJSON(hardenCommentLinks(json));
    node.check();
  } catch {
    return { error: "Comment contains formatting that comments don't allow." };
  }

  const text = commentBodyText(node);
  if (!text) {
    return { error: "Comment can't be empty." };
  }
  if (text.length > MAX_COMMENT_CHARS) {
    return { error: `Comment is too long (max ${MAX_COMMENT_CHARS} characters).` };
  }

  return { node, json: toPlainJSON(node.toJSON() as JSONContent), text };
}
