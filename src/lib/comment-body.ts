import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { COMMENT_LINK_REL, COMMENT_LINK_TARGET, pmCommentContentSchema, toPlainJSON } from "./tiptap-schema";
import { CITATION } from "./entity-chips/kinds/citation";
import { MENTION } from "./entity-chips/kinds/mention";
import { conformChipAttrs, newChipIid } from "./entity-chips/node";
import { chipKind } from "./entity-chips/registry";
import { chipsInJSON, chipTargets } from "./entity-chips/renderings";
import { chipDisplayText, chipLabels, isChip, type ChipLabels } from "./entity-chips/text";
import { CHIP_ANCHOR_TEXT, ENTITY_CHIP, type ChipContext, type ChipInputs, type ChipStyles } from "./entity-chips/types";

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
// top is the two caps §23b asks for, link hardening, which the schema
// cannot express because it is a rule about attribute *values*, and each
// entity chip's own validation (docs/ENTITY_CHIPS.md, "Planned: chips in
// comments"), since the schema checks only that a chip's `data` is there.

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

/**
 * The most entity chips one comment may hold, as the most quotations is 20
 * (`MAX_QUOTES_PER_COMMENT`). The rate limits bound how many comments there
 * are; this bounds what one of them holds, so a single comment can't mention
 * everyone on the site.
 */
export const MAX_CHIPS_PER_COMMENT = 20;

/**
 * The one style every comment's chips are shown in (docs/ENTITY_CHIPS.md,
 * "Planned: chips in comments", "The style"): a mention by name, a citation
 * author-date. Not a doc's `short`, a shorthand a stranger has no way to
 * learn; not numbers, which would collide with the post's own; and not the
 * post's style, so that a comment's labels depend on nothing but the records
 * its chips name.
 */
export const COMMENT_CHIP_STYLES: ChipStyles = {
  [MENTION]: { form: "name" },
  [CITATION]: { form: "author-date" },
};

/** The inputs a comment body's chips are rendered with: the comment style, and `context`. */
export function commentChipInputs(context: ChipContext): ChipInputs {
  return { styles: COMMENT_CHIP_STYLES, context };
}

/** Each chip's label in a comment body, in the comment style, from `context`. */
export function commentChipLabels(json: JSONContent, context: ChipContext): ChipLabels {
  return chipLabels(json, commentChipInputs(context));
}

/**
 * The targets of the chips in `json` that the insertion check asks about,
 * per chip kind: every one but those `held` already names, the body an edit
 * is of, whose chips may be written back whoever they name now.
 */
export function freshCommentChipTargets(json: JSONContent, held: JSONContent | null): Record<string, string[]> {
  const heldTargets = held ? chipTargets(chipsInJSON(held)) : {};
  const fresh: Record<string, string[]> = {};
  for (const [kind, ids] of Object.entries(chipTargets(chipsInJSON(json)))) {
    const left = ids.filter((id) => !(heldTargets[kind] ?? []).includes(id));
    if (left.length > 0) fresh[kind] = left;
  }
  return fresh;
}

export type ParsedCommentBody = {
  /** The validated node, for anything that wants positions. */
  node: PMNode;
  /** The canonical JSON to store — `node.toJSON()`, plain-prototyped. */
  json: JSONContent;
  /**
   * `commentBodyText(node)` with no labels, so a chip reads as nothing.
   * What `body_text` holds is the text with labels, which needs the chips'
   * records: the capture computes it (comment-quote-capture.ts).
   */
  text: string;
};

export type CommentBodyError = { error: string };

export function isCommentBodyError(value: ParsedCommentBody | CommentBodyError): value is CommentBodyError {
  return "error" in value;
}

/**
 * The plain text of a comment body: textblocks joined by newlines, a hard
 * break as a newline, an entity chip as its label in `labels`, trimmed. What
 * `Comment.bodyText` holds, and what the migration derived for every
 * backfilled row — one line per paragraph — so the two agree by
 * construction. Without labels a chip reads as nothing.
 */
export function commentBodyText(node: PMNode, labels?: ChipLabels): string {
  return node
    .textBetween(0, node.content.size, "\n", (leaf) => (isChip(leaf) ? chipDisplayText(leaf.attrs, labels) : "\n"))
    .trim();
}

/** `commentBodyText` for a stored JSON body; "" for anything that won't parse. */
export function commentBodyTextFromJSON(json: unknown, labels?: ChipLabels): string {
  try {
    return commentBodyText(pmCommentContentSchema.nodeFromJSON(json as JSONContent), labels);
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

// Resolves a relative href for the check below; never fetched, and never a
// real origin, so "is it still on this origin?" can be asked of the result.
const RELATIVE_PROBE_ORIGIN = "https://comment-href.invalid";

// The pages on this site a comment's link may name by a root-relative path.
const RELATIVE_PATHS = ["/pdf/", "/authors/"];

/**
 * True for an href a comment may carry: an absolute http, https or mailto URL,
 * or a root-relative link to a PDF on this site (`/pdf/<slug>…`), which is
 * how a PDF fragment link is written (docs/PDF_FRAGMENT_LINKS.md §8), or to
 * an author page (`/authors/<slug>`), which is what a mention's Markdown is
 * and what one the commenter may not insert stays (docs/ENTITY_CHIPS.md,
 * "Planned: chips in comments"). Every other relative or protocol-less URL
 * is refused.
 *
 * The path test is made on the path the URL parser settles on, not on the
 * string, so neither `/pdf/../elsewhere` nor `/pdf/\\host` gets past it. Nothing
 * renders a comment body off the site (no email carries one, and the RSS feed
 * has a post's opening text as plain text), so a relative href resolves
 * wherever it is shown.
 */
export function isAllowedCommentHref(href: unknown): href is string {
  if (typeof href !== "string" || !href.trim()) return false;
  if (href.startsWith("/")) {
    try {
      const resolved = new URL(href, RELATIVE_PROBE_ORIGIN);
      return (
        resolved.origin === RELATIVE_PROBE_ORIGIN &&
        RELATIVE_PATHS.some((prefix) => resolved.pathname.startsWith(prefix))
      );
    } catch {
      return false;
    }
  }
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

  const conformed = conformCommentChips(json);
  if ("error" in conformed) return conformed;

  let node: PMNode;
  try {
    node = pmCommentContentSchema.nodeFromJSON(hardenCommentLinks(conformed.json));
    node.check();
  } catch {
    return { error: "Comment contains formatting that comments don't allow." };
  }

  // A chip counts as one character here: its label is computed from records
  // this browser-safe check has no way to load, and a body that is a lone
  // mention is not empty.
  const counted = node.textBetween(0, node.content.size, "\n", (leaf) => (isChip(leaf) ? CHIP_ANCHOR_TEXT : "\n")).trim();
  if (!counted) {
    return { error: "Comment can't be empty." };
  }
  if (counted.length > MAX_COMMENT_CHARS) {
    return { error: `Comment is too long (max ${MAX_COMMENT_CHARS} characters).` };
  }

  return { node, json: toPlainJSON(node.toJSON() as JSONContent), text: commentBodyText(node) };
}

/**
 * Every entity chip in a submitted body as a comment stores it, or the
 * message to show:
 *
 * - its fields through its chip kind's validator, so what is stored is only
 *   what the kind names, and a chip of a kind this build doesn't know, or
 *   one the validator refuses (a Markdown placeholder nobody resolved), is
 *   refused rather than kept;
 * - no mark but a quotation's `quote`, which can span a chip;
 * - a citation's narrative form dropped: a comment has none, since its
 *   Markdown box doesn't read a bare `@key`;
 * - an instance id that is unique in the body, a fresh one given where it is
 *   missing or repeated, the first holder keeping its own;
 * - at most `MAX_CHIPS_PER_COMMENT` of them.
 *
 * Whether the commenter may insert each one is the server's question, asked
 * after this (comment-chips.ts).
 */
export function conformCommentChips(json: JSONContent): { json: JSONContent } | CommentBodyError {
  let count = 0;
  let refused = false;
  const seen = new Set<string>();
  const walk = (node: JSONContent): JSONContent => {
    if (refused) return node;
    if (isChip(node)) {
      count += 1;
      const attrs = conformChipAttrs({ kind: node.attrs?.kind, iid: node.attrs?.iid, data: node.attrs?.data });
      if (!attrs || !chipKind(attrs.kind)) {
        refused = true;
        return node;
      }
      let data = attrs.data;
      if (attrs.kind === CITATION && Object.hasOwn(data, "form")) {
        const { form: _form, ...rest } = data;
        void _form;
        data = rest;
      }
      let iid = attrs.iid;
      while (!iid || seen.has(iid)) iid = newChipIid();
      seen.add(iid);
      const marks = (node.marks ?? []).filter((mark) => mark.type === "quote");
      return { type: ENTITY_CHIP, attrs: { kind: attrs.kind, iid, data }, ...(marks.length > 0 ? { marks } : {}) };
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  const out = walk(json);
  if (refused) return { error: "Comment holds a mention or citation that can't be read." };
  if (count > MAX_CHIPS_PER_COMMENT) {
    return { error: `A comment can hold at most ${MAX_CHIPS_PER_COMMENT} mentions and citations.` };
  }
  return { json: out };
}
