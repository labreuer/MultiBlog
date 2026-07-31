import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/react";
import { renderToReactElement } from "@tiptap/static-renderer";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { contentExtensions } from "@/lib/tiptap-schema";
import { getPostThreadsWithApprovedComments } from "@/lib/comment-data";
import { publishedPostWhere } from "@/lib/post-status";
import AuthorByline from "@/components/AuthorByline";
import AnnotatableArticle from "@/components/AnnotatableArticle";
import CommentSection from "@/components/CommentSection";
import proseStyles from "@/styles/prose.module.css";
import styles from "./page.module.css";

export const revalidate = 60;

// PLAN.md §15 — a published post's content is its own proseJson/title
// columns, not a joined Revision. No collab/PostEditBadge staleness signal
// any more either: a published post is a snapshot, deliberately silent about
// whether its backing doc has moved on since (§15, "known gaps" weighed and
// declined this on purpose).
async function getPublishedPost(slug: string) {
  return prisma.post.findFirst({
    where: { slug, ...publishedPostWhere() },
    include: {
      authors: {
        orderBy: { bylineOrder: "asc" },
        include: { user: { select: { name: true, slug: true } } },
      },
    },
  });
}

export async function generateStaticParams() {
  const posts = await prisma.post.findMany({
    where: publishedPostWhere(),
    select: { slug: true },
  });
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(slug);
  if (!post?.proseJson) {
    return {};
  }
  return {
    title: post.title,
    description: extractText(post.proseJson).slice(0, 160),
  };
}

// Falls back to PostSlugHistory when `slug` isn't any post's current slug —
// old links/bookmarks 301 to wherever that post lives now instead of 404ing.
// Only redirects to a post that's actually published; a history entry for a
// since-unpublished (or soft-deleted) post falls through to notFound() same
// as today.
async function resolveRedirectSlug(slug: string): Promise<string | null> {
  // Relation filters on a nested Post aren't covered by src/lib/prisma.ts's
  // soft-delete extension (that only wraps top-level post/user operations),
  // so deletedByUserId is checked explicitly here alongside publishedPostWhere.
  const entry = await prisma.postSlugHistory.findFirst({
    where: { slug, post: { ...publishedPostWhere(), deletedByUserId: null } },
    select: { post: { select: { slug: true } } },
  });
  return entry?.post.slug ?? null;
}

export default async function PublicPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPublishedPost(slug);
  if (!post?.proseJson) {
    const redirectSlug = await resolveRedirectSlug(slug);
    if (redirectSlug) {
      permanentRedirect(`/${redirectSlug}`);
    }
    notFound();
  }

  const doc = post.proseJson as JSONContent;
  const staticContent = renderToReactElement({ content: doc, extensions: contentExtensions });

  const threads = await getPostThreadsWithApprovedComments(post.id);
  const quoteHighlights = threads
    // A thread where every comment has been deleted has nothing left to
    // show in the comment list (CommentEntryList hides its header the same
    // way — see hasNonDeletedDescendant), so the inline highlight/badge
    // shouldn't linger over the quoted text either.
    .filter((t) => t.quotedText !== "" && t.status === "ACTIVE" && t.comments.some((c) => c.deletedByUserId === null))
    .map((t) => ({
      id: t.id,
      // Never null here: getPostThreadsWithApprovedComments always supplies
      // real offsets for a quote thread — anchorFrom/anchorTo are nullable
      // on the shared ThreadWithComments type only because a doc annotation
      // (PLAN.md §12i) has no equivalent stored offset.
      from: t.anchorFrom!,
      to: t.anchorTo!,
      count: t.comments.filter((c) => c.deletedByUserId === null).length,
      color: t.color,
    }));

  return (
    <div className={styles.container}>
      <main className={styles.main}>
        <h1 className={styles.title}>{post.title}</h1>
        <p className={styles.byline}>
          <AuthorByline authors={post.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name }))} />
          {post.publishedAt?.toLocaleDateString()}
        </p>
        <AnnotatableArticle
          postId={post.id}
          doc={doc}
          threads={quoteHighlights}
          staticContent={<div className={proseStyles.prose}>{staticContent}</div>}
        />
        <CommentSection postId={post.id} />
        <p>
          <Link href="/">← Back to all posts</Link>
        </p>
      </main>
    </div>
  );
}
