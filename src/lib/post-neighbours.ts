import { prisma } from "@/lib/prisma";
import { publishedPostWhere } from "@/lib/post-status";
import { postListOrderBy } from "@/lib/post-pages";

// docs/BLOG.md — the published posts immediately older and newer than a post,
// in the listing's own order (src/lib/post-pages.ts), so "Older" from a post
// is the post below it on the listing.
//
// The post's page renders with this, and revalidatePostNeighbours
// (src/lib/revalidate-post.ts) finds the pages to refresh with it, so the two
// can't disagree about who the neighbours are. The comparisons are strict on
// `(publishedAt, id)`, which leaves the post itself out whatever its state.
// That is what makes one call right on both sides of a change: after a
// publish it finds the posts that now link to this one, after an unpublish or
// a delete the two that did.

export type PostNeighbour = { slug: string; title: string; publishedAt: Date | null };

export type PostNeighbours = { older: PostNeighbour | null; newer: PostNeighbour | null };

const neighbourSelect = { slug: true, title: true, publishedAt: true } as const;

// Each side carries a plain bound on `publishedAt` beside the OR that breaks
// ties. The bound changes no result, since the OR implies it, but it is what
// Postgres can seek on: the OR alone stays a filter, so the scan would start
// at the newest post (or the oldest) and read its way to this one. Measured
// on 100,000 rows: 56,152 rows filtered without the bound, none with it.
export async function findPostNeighbours(post: { id: string; publishedAt: Date }): Promise<PostNeighbours> {
  const { id, publishedAt } = post;
  const [older, newer] = await Promise.all([
    prisma.post.findFirst({
      where: {
        AND: [
          publishedPostWhere(),
          { publishedAt: { lte: publishedAt } },
          { OR: [{ publishedAt: { lt: publishedAt } }, { publishedAt, id: { lt: id } }] },
        ],
      },
      orderBy: postListOrderBy,
      select: neighbourSelect,
    }),
    prisma.post.findFirst({
      where: {
        AND: [
          publishedPostWhere(),
          { publishedAt: { gte: publishedAt } },
          { OR: [{ publishedAt: { gt: publishedAt } }, { publishedAt, id: { gt: id } }] },
        ],
      },
      orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
      select: neighbourSelect,
    }),
  ]);
  return { older, newer };
}
