import type { Prisma } from "@/generated/prisma/client";

// docs/BLOG.md — the blog's listing is one list split into pages: `/` is page
// 1 and `/page/N` the rest. Both routes read their page size and order from
// here, since the two are halves of one list and a disagreement between them
// would make a page repeat or skip posts.
//
// Pure and browser-safe, so its rejection surface sits under test:unit.

export const POSTS_PER_PAGE = 10;

/**
 * Newest first, ties broken by `id` so the order is total. Without the tie
 * break, two posts with one timestamp may swap between renders, and a page
 * boundary falling between them shows one twice and the other never. A post's
 * older and newer neighbours (src/lib/post-neighbours.ts) walk this same order.
 */
export const postListOrderBy: Prisma.PostOrderByWithRelationInput[] = [{ publishedAt: "desc" }, { id: "desc" }];

/**
 * `/page/N`'s segment as a page number, or null for anything that isn't one:
 * a positive integer, written without a leading zero or a sign. 1 is a page
 * number (the route redirects it to `/`); whether N is past the end is the
 * route's question, since only it knows the count.
 */
export function parsePageParam(raw: string): number | null {
  if (!/^[1-9]\d{0,5}$/.test(raw)) return null;
  return Number(raw);
}

/** How many pages `total` posts fill. One page however few, since `/` always exists. */
export function postPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
}

/** Page 1 is the landing page itself; there is no `/page/1`. */
export function postPagePath(page: number): string {
  return page === 1 ? "/" : `/page/${page}`;
}
