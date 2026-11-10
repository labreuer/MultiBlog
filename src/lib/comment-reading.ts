import type { JSONContent } from "@tiptap/core";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { canUserReadComment } from "@/lib/comment-authz";
import { visibleVersions, withSupersededAt } from "@/lib/edit-grace";
import { commentBodyTextFromJSON } from "@/lib/comment-body";
import { commentChipContext, commentChipInputs, commentChipLabels, commentMarkdownOf, commentMentionableAmong } from "@/lib/comment-chips";
import { loadContextForIds } from "@/lib/entity-chips/context-for";
import { CITATION } from "@/lib/entity-chips/kinds/citation";
import { MENTION } from "@/lib/entity-chips/kinds/mention";
import { chipsInJSON, chipTargets } from "@/lib/entity-chips/renderings";
import { displayNameOf } from "@/lib/display-name";
import { viewerOf, type Actor } from "@/lib/actor";
import type { ChipContext, ChipInputs } from "@/lib/entity-chips/types";

// A comment's body as Markdown, and its history — what `getCommentMarkdown`
// and `getCommentHistory` (src/app/actions/comments.ts) answer, as plain
// functions taking an explicit viewer (docs/MCP.md §1), so the MCP server's
// comment read goes through the same gate and the same silence rule.
//
// Both gate on `canUserReadComment`: anyone, for a public comment (approved,
// not deleted, on a published post); its own writer; anyone who may moderate
// the post.

type Viewer = { id: string; role: Role } | null;

/** What canUserReadComment needs of a comment's post: whether it is public, not just its id. */
export const READABLE_COMMENT_INCLUDE = {
  commenter: { select: { userId: true } },
  thread: { select: { post: { select: { id: true, publishedAt: true, publishEventId: true, deletedByUserId: true } } } },
} as const;

/**
 * PLAN.md §23m — the stored body serialized back to Markdown, on demand rather
 * than stored: a second stored form of one body is the two-copies problem §23f
 * avoids, and the round trip is microseconds. Null when the viewer may not
 * read the comment, or there is none.
 */
export async function commentMarkdownFor(viewer: Viewer, commentId: string): Promise<string | null> {
  const body = await readableCommentBody(viewer, commentId);
  return body === null ? null : commentMarkdownOf(body);
}

/** The stored body, for `actor` (null: signed out) if they may read it: what an edit's conversion holds. */
export async function commentBodyFor(actor: Actor | null, commentId: string): Promise<JSONContent | null> {
  return readableCommentBody(actor ? viewerOf(actor) : null, commentId);
}

async function readableCommentBody(viewer: Viewer, commentId: string): Promise<JSONContent | null> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: READABLE_COMMENT_INCLUDE });
  if (!comment || !(await canUserReadComment(viewer, comment))) return null;
  return comment.body as JSONContent;
}

export type CommentVersion = {
  revisionNo: number;
  body: JSONContent;
  bodyText: string;
  createdAt: string;
  authorName: string | null;
  /** The text currently on screen, i.e. the newest version. */
  current: boolean;
  /** The records its chips are labelled from: one context for every version listed, the same object on each. */
  chipContext: ChipContext;
};

/**
 * PLAN.md §22c — the versions a reader may see, newest first. **The silence
 * rule runs here, on the server**, so a silent version never reaches anyone:
 * shipping every revision and hiding some in the client would put the text of
 * an edit nobody is meant to know about into a payload anyone can read. Each
 * version's author is a name, selected without an email to fall back on.
 */
export async function commentHistoryFor(viewer: Viewer, commentId: string): Promise<CommentVersion[]> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: {
      ...READABLE_COMMENT_INCLUDE,
      revisions: {
        orderBy: { revisionNo: "asc" },
        include: { author: { select: { name: true } }, quotedBy: { select: { id: true }, take: 1 } },
      },
    },
  });
  if (!comment) return [];

  // Who may see it: the same people who may see the comment. An APPROVED,
  // undeleted comment on a published post is public, so its history is too —
  // that is the whole point of a visible edit.
  if (!(await canUserReadComment(viewer, comment))) return [];

  // §22b's other clause: a version a comment_quote_anchor pins is never
  // silent, so the reader of the quote has something to find.
  const versions = withSupersededAt(comment.revisions, (revision) => revision.quotedBy.length > 0);
  const visible = visibleVersions(versions, comment.createdAt);
  const newestNo = versions[versions.length - 1]?.revisionNo;
  // An earlier version can name someone the current one doesn't.
  const chipContext = await commentChipContext(visible.map((revision) => revision.body));

  return visible
    .map((revision) => ({
      revisionNo: revision.revisionNo,
      body: revision.body as JSONContent,
      bodyText: commentBodyTextFromJSON(revision.body, commentChipLabels(revision.body as JSONContent, chipContext)),
      createdAt: revision.createdAt.toISOString(),
      authorName: revision.author ? displayNameOf(revision.author) : null,
      current: revision.revisionNo === newestNo,
      chipContext,
    }))
    .reverse();
}

/**
 * docs/ENTITY_CHIPS.md, "Chips in comments" — the chip context for
 * one comment, as `actor` (null: signed out) may have it, or null when they
 * may not read the comment: `GET /api/chip-context?comment=<id>`, under the
 * comment's own read rule. It answers for the chips the stored body holds,
 * and, of `asked`, for the people the actor may mention in a comment on its
 * post and any work, every reference's page being public.
 */
export async function commentChipInputsFor(
  actor: Actor | null,
  commentId: string,
  asked: Record<string, readonly string[]>,
): Promise<ChipInputs | null> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: READABLE_COMMENT_INCLUDE });
  if (!comment || !(await canUserReadComment(actor ? viewerOf(actor) : null, comment))) return null;
  const held = chipTargets(chipsInJSON(comment.body as JSONContent));
  const people = new Set(held[MENTION] ?? []);
  const askedPeople = (asked[MENTION] ?? []).filter((id) => !people.has(id));
  for (const id of await commentMentionableAmong(actor, comment.thread.post.id, askedPeople)) people.add(id);
  const works = new Set([...(held[CITATION] ?? []), ...(asked[CITATION] ?? [])]);
  return commentChipInputs(await loadContextForIds({ [MENTION]: people, [CITATION]: works }));
}
