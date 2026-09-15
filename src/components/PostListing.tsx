import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import { extractText } from "@/lib/diff";
import { postPath } from "@/lib/post-path";
import AuthorByline from "@/components/AuthorByline";
import PostDate from "@/components/PostDate";
import styles from "./PostListing.module.css";

// The one post-preview list (PLAN.md §21h): title, byline, date, 200-char
// excerpt. The landing page, /search, /authors/[slug] and the date archives
// all render this — before it existed each carried its own copy of the same
// <article>, and the fourth copy was the moment to stop.
//
// A Server Component, and it must stay one: every surface rendering it is
// ISR (`revalidate = 60`) and reads no session, so nothing here may either.

const EXCERPT_LENGTH = 200;

/**
 * What a listing needs from a `Post` row. Spread into each surface's own
 * `findMany` so the four queries can't drift from the component's props —
 * the byline needs the authors in byline order, the excerpt needs the body.
 */
export const postListingInclude = {
  authors: {
    orderBy: { bylineOrder: "asc" },
    include: { user: { select: { name: true, slug: true } } },
  },
} satisfies Prisma.PostInclude;

export type ListedPost = Prisma.PostGetPayload<{ include: typeof postListingInclude }>;

export default function PostListing({ posts, emptyMessage }: { posts: ListedPost[]; emptyMessage: string }) {
  if (posts.length === 0) {
    return <p className={styles.empty}>{emptyMessage}</p>;
  }
  return posts.map((post) => {
    const excerpt = post.proseJson ? extractText(post.proseJson).slice(0, EXCERPT_LENGTH) : "";
    return (
      <article key={post.id} className={styles.article}>
        <h2 className={styles.heading}>
          <Link href={postPath(post)} className={styles.titleLink}>
            {post.title}
          </Link>
        </h2>
        <p className={styles.meta}>
          <AuthorByline authors={post.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name }))} />
          {/* Never null: every listing queries through publishedPostWhere(). */}
          <PostDate publishedAt={post.publishedAt!} />
        </p>
        <p>
          {excerpt}
          {excerpt.length === EXCERPT_LENGTH ? "…" : ""}
        </p>
      </article>
    );
  });
}
