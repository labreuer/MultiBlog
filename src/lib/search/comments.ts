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
import { orderNewest, orderRanked, rankRows, snippetsFor } from "./sql";
import { remember, type KindContext, type KindSearch } from "./context";
import type { CommentHit } from "./types";

/**
 * The readable ids, the first half of `match` (§4): the public comments
 * under the filters, each with when it was posted.
 *
 * A comment's name is the one it was posted under, fixed when its commenter
 * row was made, so filtering by an account would tie an old name to a
 * renamed one (§10, item 3). An author filter leaves comments out instead.
 */
function candidates(ctx: KindContext): Promise<Map<string, Date>> {
  return remember(ctx, "comments", async () => {
    if (ctx.authorIds.length > 0) return new Map();
    const rows = await prisma.comment.findMany({
      where: {
        AND: [
          publicCommentsWhere(),
          ctx.created ? { createdAt: ctx.created } : {},
          ctx.excludePostId ? { thread: { postId: { not: ctx.excludePostId } } } : {},
        ],
      },
      select: { id: true, createdAt: true },
    });
    return new Map(rows.map((c) => [c.id, c.createdAt]));
  });
}

/**
 * Updated is the last edit readers are told about, never `editedAt` (§6;
 * annotations.ts says why): the cards' own rule (`isCommentVisiblyEdited`)
 * over the same version timestamps, for every candidate at once.
 */
function updatedDates(ctx: KindContext): Promise<{ updated: Map<string, Date>; edited: Map<string, Date | null> }> {
  return remember(ctx, "comments:updated", async () => {
    const posted = await candidates(ctx);
    const rows =
      posted.size > 0
        ? await prisma.comment.findMany({
            where: { id: { in: [...posted.keys()] } },
            select: {
              id: true,
              createdAt: true,
              editedAt: true,
              revisions: {
                orderBy: { revisionNo: "asc" },
                select: { createdAt: true, quotedBy: { select: { id: true }, take: 1 } },
              },
            },
          })
        : [];
    const edited = new Map(rows.map((row) => [row.id, isCommentVisiblyEdited(row) ? row.editedAt : null]));
    const updated = new Map<string, Date>();
    for (const [id, createdAt] of posted) {
      const date = edited.get(id) ?? createdAt;
      if (isWithin(date, ctx.updated)) updated.set(id, date);
    }
    return { updated, edited };
  });
}

export const commentsSearch: KindSearch<CommentHit> = {
  async match(ctx, query) {
    const { updated } = await updatedDates(ctx);
    const dateOf = (id: string) => updated.get(id) ?? null;
    const ids = [...updated.keys()];
    return query ? orderRanked(await rankRows("comment", ids, query), dateOf) : orderNewest(ids, dateOf);
  },

  async hits(ctx, ids, query) {
    if (ids.length === 0) return [];
    const [{ edited }, snippets, rows] = await Promise.all([
      updatedDates(ctx),
      snippetsFor("comment", ids, query, { body: Prisma.sql`t.body_text`, title: null }),
      prisma.comment.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          createdAt: true,
          commenter: { select: { displayName: true } },
          thread: { select: { post: { select: { title: true, slug: true, publishedAt: true } } } },
        },
      }),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id): CommentHit[] => {
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
          editedAt: edited.get(id) ?? null,
          snippet: snippets.get(id)?.body ?? [],
        },
      ];
    });
  },
};
