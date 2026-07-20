import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/react";
import { renderToReactElement } from "@tiptap/static-renderer";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { contentExtensions } from "@/lib/tiptap-schema";
import { getPostThreadsWithApprovedComments } from "@/lib/comment-data";
import { getPostEditStatus } from "@/lib/post-edit-status";
import AuthorByline from "@/components/AuthorByline";
import AnnotatableArticle from "@/components/AnnotatableArticle";
import CommentSection from "@/components/CommentSection";
import PostEditBadge from "@/components/PostEditBadge";
import proseStyles from "@/styles/prose.module.css";

export const revalidate = 60;

async function getPublishedPost(slug: string) {
  return prisma.post.findFirst({
    where: { slug, status: "PUBLISHED", currentRevisionId: { not: null } },
    include: {
      currentRevision: true,
      authors: {
        orderBy: { bylineOrder: "asc" },
        include: { user: { select: { name: true } } },
      },
      revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { createdAt: true } },
      collab: { select: { updatedAt: true } },
    },
  });
}

export async function generateStaticParams() {
  const posts = await prisma.post.findMany({
    where: { status: "PUBLISHED" },
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
  if (!post?.currentRevision) {
    return {};
  }
  return {
    title: post.currentRevision.title,
    description: extractText(post.currentRevision.doc).slice(0, 160),
  };
}

export default async function PublicPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await getPublishedPost(slug);
  if (!post?.currentRevision) {
    notFound();
  }

  const session = await auth();
  const userName = session?.user ? (session.user.name ?? session.user.email ?? null) : null;
  const editStatus = getPostEditStatus(session?.user, post);

  const doc = post.currentRevision.doc as JSONContent;
  const staticContent = renderToReactElement({ content: doc, extensions: contentExtensions });

  const threads = await getPostThreadsWithApprovedComments(post.id);
  const quoteHighlights = threads
    .filter((t) => t.quotedText !== "" && t.status === "ACTIVE")
    .map((t) => ({ id: t.id, from: t.anchorFrom, to: t.anchorTo, count: t.comments.length }));

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <main style={{ padding: "1rem" }}>
        <h1>
          {post.currentRevision.title}
          {editStatus.canEdit && <PostEditBadge postId={post.id} hasPendingEdits={editStatus.hasPendingEdits} />}
        </h1>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          <AuthorByline authors={post.authors.map((a) => ({ userId: a.userId, name: a.user.name }))} />
          {post.publishedAt?.toLocaleDateString()}
        </p>
        <AnnotatableArticle
          postId={post.id}
          doc={doc}
          threads={quoteHighlights}
          userName={userName}
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
