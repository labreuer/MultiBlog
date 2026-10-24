import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { publishedPostWhere } from "@/lib/post-status";
import { POSTS_PER_PAGE, parsePageParam, postListOrderBy, postPageCount } from "@/lib/post-pages";
import PostListing, { postListingInclude } from "@/components/PostListing";
import PostPager from "@/components/PostPager";
import styles from "./page.module.css";

// docs/BLOG.md §6 — `/page/N`, the landing page's listing continued: page 1
// is `/` itself, which this route's `/page/1` redirects to. A path rather
// than `?page=`, because page 1 is `/`, and reading searchParams would make
// `/` dynamic. This route is rendered on every request, like the date
// archives: with no generateStaticParams it gets no cache in this version of
// Next, and `revalidate` below does nothing until it gains one (§8).
//
// The segment is checked before the first query, as everything under
// `[year]` does (docs/BLOG.md §3). Unlike an archive's empty day, a page past
// the end names nothing, so it 404s.
//
// No auth()/cookies()/headers() anywhere below, so caching it stays a matter
// of adding generateStaticParams (CACHING.md, 2026-10-23).
export const revalidate = 60;

type Params = Promise<{ n: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const page = parsePageParam((await params).n);
  return page && page > 1 ? { title: `Older posts, page ${page}` } : {};
}

export default async function PostListPage({ params }: { params: Params }) {
  const page = parsePageParam((await params).n);
  if (page === null) notFound();
  if (page === 1) permanentRedirect("/");

  const [posts, total] = await Promise.all([
    prisma.post.findMany({
      where: publishedPostWhere(),
      orderBy: postListOrderBy,
      skip: (page - 1) * POSTS_PER_PAGE,
      take: POSTS_PER_PAGE,
      include: postListingInclude,
    }),
    prisma.post.count({ where: publishedPostWhere() }),
  ]);
  const pageCount = postPageCount(total);
  if (page > pageCount) notFound();

  return (
    <div className={styles.container}>
      <main className={styles.main}>
        <h1 className={styles.title}>Older posts</h1>
        <PostPager page={page} pageCount={pageCount} />
        <PostListing posts={posts} emptyMessage="No posts on this page." />
        <PostPager page={page} pageCount={pageCount} />
      </main>
    </div>
  );
}
