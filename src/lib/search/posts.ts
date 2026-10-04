// docs/FULLTEXT.md — searching posts: each post's own published or scheduled
// text, under the post's read rule, never its doc's (§1, §2).
//
// `readablePostWhere` for a viewer: the published posts, plus the
// unpublished ones they may edit — every one for an ADMIN or EDITOR, the
// ones on their byline for an AUTHOR — which is how /tag widens too. Those
// link into the editor with a `draft` or `scheduled` marker, since neither
// has a public URL that answers. The public scope (the quote picker) is
// `publishedPostWhere` alone.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { derivePostStatus, publishedPostWhere, readablePostWhere } from "@/lib/post-status";
import { postPath } from "@/lib/post-path";
import { isWithin } from "./dates";
import { orderNewest, orderRanked, rankRows, snippetsFor, windowOf } from "./sql";
import type { KindContext, KindResult } from "./context";
import type { PostHit } from "./types";

/**
 * A post's two dates for the filters (§6). Created is the go-live date the
 * post shows, which survives a republish; a draft that never went live has
 * only its row's own. Updated is the later of that and the live publication
 * event's — later only after a republish (PLAN.md §15c).
 */
function postDates(post: { createdAt: Date; publishedAt: Date | null; publishEvent: { createdAt: Date } | null }) {
  const created = post.publishedAt ?? post.createdAt;
  const event = post.publishEvent?.createdAt;
  return { created, updated: event && event > created ? event : created };
}

export async function searchPosts(ctx: KindContext): Promise<KindResult<PostHit>> {
  const readable =
    ctx.scope === "public" ? publishedPostWhere() : readablePostWhere(ctx.actor?.userId ?? null, ctx.actor?.role ?? null);

  // §4 step 1. The dates are computed (above) rather than columns, so they
  // are applied here over the candidates rather than in the `where`; a
  // site's posts number in the dozens.
  const candidates = await prisma.post.findMany({
    where: {
      AND: [readable, ctx.authorIds.length > 0 ? { authors: { some: { userId: { in: ctx.authorIds } } } } : {}],
    },
    select: { id: true, createdAt: true, publishedAt: true, publishEvent: { select: { createdAt: true } } },
  });
  const updatedAt = new Map<string, Date>();
  for (const post of candidates) {
    const dates = postDates(post);
    if (isWithin(dates.created, ctx.created) && isWithin(dates.updated, ctx.updated)) updatedAt.set(post.id, dates.updated);
  }
  const dateOf = (id: string) => updatedAt.get(id) ?? null;

  const ordered = ctx.query
    ? orderRanked(await rankRows("post", [...updatedAt.keys()], ctx.query), dateOf)
    : orderNewest([...updatedAt.keys()], dateOf);
  const onScreen = windowOf(ordered, ctx.window);

  const [snippets, rows] = await Promise.all([
    // A draft that was never published has no prose_json, so its snippet is
    // empty: it is found by its title, and its words through its doc (§1).
    snippetsFor("post", onScreen, ctx.query, {
      body: Prisma.sql`public.prose_text(t.prose_json)`,
      title: Prisma.sql`t.title`,
    }),
    prisma.post.findMany({
      where: { id: { in: onScreen } },
      select: {
        id: true,
        slug: true,
        publishedAt: true,
        publishEventId: true,
        authors: {
          orderBy: { bylineOrder: "asc" },
          select: { userId: true, user: { select: { slug: true, name: true } } },
        },
      },
    }),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const hits = onScreen.flatMap((id): PostHit[] => {
    const post = byId.get(id);
    if (!post) return [];
    const status = derivePostStatus(post);
    return [
      {
        id,
        href: status === "published" ? postPath(post) : `/post/${post.id}/edit`,
        title: snippets.get(id)?.title ?? [],
        byline: post.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name })),
        status,
        publishedAt: status === "draft" ? null : post.publishedAt,
        snippet: snippets.get(id)?.body ?? [],
      },
    ];
  });
  return { total: ordered.length, hits };
}
