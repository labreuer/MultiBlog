// docs/FULLTEXT.md — searching comments: the current revision's text (§1),
// for every viewer only the public ones — APPROVED, undeleted, on a post that
// is published (§2). A PENDING comment isn't found even by the post's
// moderators: a hit has to link to a page that shows it, and the post page
// shows only APPROVED ones. /comments keeps its own `?q=`.
//
// No revision is indexed, or a hit on an old wording would reveal that a
// silent edit happened at all (§1).

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { publicCommentsWhere } from "@/lib/comment-authz";
import { isCommentVisiblyEdited } from "@/lib/comment-data";
import { commentAnchorName } from "@/lib/comment-anchor-name";
import { postPath } from "@/lib/post-path";
import { isWithin } from "./dates";
import { orderNewest, orderRanked, rankRows, snippetsFor, windowOf } from "./sql";
import { NO_HITS, type KindContext, type KindResult } from "./context";
import type { CommentHit } from "./types";

/**
 * The edit date each comment's card shows, or null — the card's own rule
 * (`isCommentVisiblyEdited`) over the same version timestamps, so the date
 * filter can't find a silent edit the card keeps quiet about (§6).
 */
async function visibleEditDates(ids: string[]): Promise<Map<string, Date | null>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.comment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      createdAt: true,
      editedAt: true,
      revisions: {
        orderBy: { revisionNo: "asc" },
        select: { createdAt: true, quotedBy: { select: { id: true }, take: 1 } },
      },
    },
  });
  return new Map(rows.map((row) => [row.id, isCommentVisiblyEdited(row) ? row.editedAt : null]));
}

export async function searchComments(ctx: KindContext): Promise<KindResult<CommentHit>> {
  // A comment's name is the one it was posted under, fixed when its
  // commenter row was made, so filtering by an account would tie an old name
  // to a renamed one (§10). An author filter leaves comments out instead
  // (search/index.ts).
  if (ctx.authorIds.length > 0) return NO_HITS;

  const candidates = await prisma.comment.findMany({
    where: { AND: [publicCommentsWhere(), ctx.created ? { createdAt: ctx.created } : {}] },
    select: { id: true, createdAt: true },
  });
  const createdAt = new Map(candidates.map((c) => [c.id, c.createdAt]));

  const ranks = ctx.query ? await rankRows("comment", [...createdAt.keys()], ctx.query) : null;
  const matched = ranks ? [...ranks.keys()] : [...createdAt.keys()];

  // Updated is the last edit readers are told about, never `editedAt` (§6;
  // annotations.ts says why). Filtered and ordered here, over the matches.
  const edits = await visibleEditDates(matched);
  const updatedAt = new Map<string, Date>();
  for (const id of matched) {
    const updated = edits.get(id) ?? createdAt.get(id) ?? null;
    if (updated && isWithin(updated, ctx.updated)) updatedAt.set(id, updated);
  }
  const dateOf = (id: string) => updatedAt.get(id) ?? null;
  const ordered = ranks
    ? orderRanked(new Map([...ranks].filter(([id]) => updatedAt.has(id))), dateOf)
    : orderNewest([...updatedAt.keys()], dateOf);
  const onScreen = windowOf(ordered, ctx.window);

  const [snippets, rows] = await Promise.all([
    snippetsFor("comment", onScreen, ctx.query, { body: Prisma.sql`t.body_text`, title: null }),
    prisma.comment.findMany({
      where: { id: { in: onScreen } },
      select: {
        id: true,
        createdAt: true,
        commenter: { select: { displayName: true } },
        thread: { select: { post: { select: { title: true, slug: true, publishedAt: true } } } },
      },
    }),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const hits = onScreen.flatMap((id): CommentHit[] => {
    const row = byId.get(id);
    if (!row) return [];
    const post = row.thread.post;
    return [
      {
        id,
        href: `${postPath(post)}#${commentAnchorName(row.commenter.displayName, row.createdAt)}`,
        commenter: row.commenter.displayName,
        postTitle: post.title,
        createdAt: row.createdAt,
        editedAt: edits.get(id) ?? null,
        snippet: snippets.get(id)?.body ?? [],
      },
    ];
  });
  return { total: ordered.length, hits };
}
