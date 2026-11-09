import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import {
  COMMENT_CHIP_STYLES,
  commentBodyText,
  commentChipInputs,
  commentChipLabels,
  freshCommentChipTargets,
  isCommentBodyError,
  MAX_COMMENT_CHARS,
  MAX_COMMENT_JSON_CHARS,
  MAX_COMMENT_MARKDOWN_CHARS,
  parseCommentBody,
  type CommentBodyError,
  type ParsedCommentBody,
} from "@/lib/comment-body";
import type { CommentBodyInput } from "@/lib/comment-body-value";
import { loadChipContext } from "@/lib/entity-chips/context";
import { CITATION } from "@/lib/entity-chips/kinds/citation";
import { canInsertMentions, MENTION } from "@/lib/entity-chips/kinds/mention";
import { mentionableAmong } from "@/lib/entity-chips/kinds/mention-rule";
import { resolveParsedCommentChips } from "@/lib/entity-chips/parsed-chips";
import { chipLabelsIn } from "@/lib/entity-chips/text";
import { chipMarkdowns, chipsInJSON } from "@/lib/entity-chips/renderings";
import type { ChipContext } from "@/lib/entity-chips/types";
import { commentContentToMarkdown, markdownToCommentContent } from "@/lib/markdown-import";

// docs/ENTITY_CHIPS.md, "Planned: chips in comments" — the server half of a
// comment's mentions and citations: who a commenter may name, the one write
// path's chip resolution and insertion check, and the chips' records for
// every surface that shows or writes a comment body. Server-only.
//
// **A commenter is offered what the site already shows them.** Anyone, signed
// in or not, may mention the post's byline and the landing page's
// contributors; an AUTHOR or above may also mention everyone the doc rule
// offers them, with the post's doc as "this doc" (docs/MENTIONS.md, "Who is
// listed"). Commenting puts no one in the list: a comment never carries its
// commenter's user id, so a mention of a commenter would tie the name they
// commented under to their account. Any work in the library may be cited,
// since every reference's page is public.

/** Who is writing a comment: an account, or nobody signed in. */
export type CommentWriter = Actor | null;

/** Of `userIds`, the ones `writer` may mention in a comment on `postId`, in the order given. */
export async function commentMentionableAmong(writer: CommentWriter, postId: string, userIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { docId: true } });
  if (!post) return [];

  // The default client leaves soft-deleted accounts out, as the doc rule does.
  const shown = await prisma.user.findMany({
    where: {
      id: { in: ids },
      OR: [{ postAuthors: { some: { postId } } }, { isListedContributor: true, name: { not: null }, NOT: { name: "" } }],
    },
    select: { id: true },
  });
  const allowed = new Set(shown.map((row) => row.id));
  if (writer && canInsertMentions(writer.role)) {
    for (const id of await mentionableAmong(writer, post.docId, ids.filter((id) => !allowed.has(id)))) allowed.add(id);
  }
  return ids.filter((id) => allowed.has(id));
}

/** Where a comment body is being written: its post, the writer, and on an edit the body as it stands. */
export type CommentChipScope = {
  writer: CommentWriter;
  postId: string;
  /** The comment's current body on an edit, whose chips may be written back whatever the rule says now; null for a new one. */
  held: JSONContent | null;
};

/** A key no reference has, refused in the commenter's words: an MCP client's message names tools a commenter has never heard of. */
function unknownChipMessage(err: ApiError): string {
  const keys = Array.isArray(err.details.keys) ? (err.details.keys as string[]) : [];
  if (keys.length === 0) return err.message;
  const list = keys.map((key) => `@${key}`).join(", ");
  return err.details.deleted === true
    ? `${list} ${keys.length > 1 ? "are works" : "is a work"} deleted from the library, and can't be cited until restored.`
    : `No work in the library has the key ${list}. To write an @ that isn't a citation, write \\@.`;
}

/**
 * What a client sent, as the body to store, or the message to show: the one
 * write path for both front doors (PLAN.md §23m), with the chips resolved and
 * checked.
 *
 * - A Markdown source is parsed with the comment's chip syntax, and each
 *   placeholder resolved under the comment's rule. A mention the commenter may
 *   not insert stays the link it also is; an unknown key refuses, naming it.
 * - A rich body is the editor's JSON, decoded from the string it travelled as.
 * - Both then go through `parseCommentBody`, so the schema, the caps, the link
 *   hardening and each chip kind's validator apply whichever door the body
 *   came through, and then through the insertion check (`checkCommentChips`).
 *
 * Quotations come after this, in the capture, which writes their chips itself.
 */
export async function resolveCommentBody(input: CommentBodyInput, scope: CommentChipScope): Promise<ParsedCommentBody | CommentBodyError> {
  if (!input.content.trim()) return { error: "Comment can't be empty." };

  let json: unknown;
  if (input.format === "markdown") {
    // A cap on the *source* so a megabyte never reaches the parser; the cap
    // that matters is parseCommentBody's, on the resulting text.
    if (input.content.length > MAX_COMMENT_MARKDOWN_CHARS) {
      return { error: `Comment is too long (max ${MAX_COMMENT_CHARS} characters).` };
    }
    try {
      json = await resolveParsedCommentChips(markdownToCommentContent(input.content), {
        held: scope.held,
        mentionable: (ids) => commentMentionableAmong(scope.writer, scope.postId, ids),
      });
    } catch (err) {
      if (err instanceof ApiError) return { error: err.code === "unknown_chip" ? unknownChipMessage(err) : err.message };
      throw err;
    }
  } else {
    if (input.content.length > MAX_COMMENT_JSON_CHARS) {
      return { error: `Comment is too long (max ${MAX_COMMENT_CHARS} characters).` };
    }
    try {
      json = JSON.parse(input.content);
    } catch {
      return { error: "Malformed comment." };
    }
  }

  const parsed = parseCommentBody(json);
  if (isCommentBodyError(parsed)) return parsed;
  const refused = await checkCommentChips(parsed.json, scope);
  return refused ?? parsed;
}

/**
 * The insertion check: every chip in `json` is one the writer may insert, or
 * one the comment already holds (`scope.held`). The rich editor's JSON is
 * the client's own, so this is what keeps it from naming an account the
 * menu wouldn't offer. Null when every chip passes.
 */
export async function checkCommentChips(json: JSONContent, scope: CommentChipScope): Promise<CommentBodyError | null> {
  const fresh = freshCommentChipTargets(json, scope.held);

  const people = fresh[MENTION] ?? [];
  if (people.length > 0) {
    const allowed = new Set(await commentMentionableAmong(scope.writer, scope.postId, people));
    if (people.some((id) => !allowed.has(id))) return { error: "This comment mentions someone who can't be mentioned here." };
  }

  const works = fresh[CITATION] ?? [];
  if (works.length > 0) {
    const found = await prisma.reference.findMany({ where: { id: { in: works } }, select: { id: true, deletedAt: true } });
    const live = new Set(found.filter((row) => row.deletedAt === null).map((row) => row.id));
    if (works.some((id) => !live.has(id))) return { error: "This comment cites a work the library doesn't have." };
  }
  return null;
}

/** The records every chip in `bodies` is labelled from: one context, loaded in one pass, nothing loaded for bodies with none. */
export async function commentChipContext(bodies: readonly unknown[]): Promise<ChipContext> {
  const chips = bodies.flatMap((body) => (body && typeof body === "object" ? chipsInJSON(body as JSONContent) : []));
  return chips.length > 0 ? loadChipContext(chips) : {};
}

/** A comment body's `body_text`: its text with each chip's label, in the comment style. */
export async function commentTextWithLabels(node: PMNode): Promise<string> {
  const json = node.toJSON() as JSONContent;
  if (chipsInJSON(json).length === 0) return commentBodyText(node);
  return commentBodyText(node, chipLabelsIn(node, commentChipInputs(await commentChipContext([json]))));
}

/** A comment body as its Markdown: each chip in its chip kind's syntax, labelled in the comment style. */
export async function commentMarkdownOf(json: JSONContent, context?: ChipContext): Promise<string> {
  const chips = chipsInJSON(json);
  if (chips.length === 0) return commentContentToMarkdown(json);
  const records = context ?? (await commentChipContext([json]));
  return commentContentToMarkdown(json, chipMarkdowns(chips, COMMENT_CHIP_STYLES, records));
}

/** Re-exported beside the loaders for the surfaces that use both. */
export { commentChipInputs, commentChipLabels };
