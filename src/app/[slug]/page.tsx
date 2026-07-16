import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/react";
import { renderToReactElement } from "@tiptap/static-renderer";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { contentExtensions } from "@/lib/tiptap-schema";
import SiteHeader from "@/components/SiteHeader";
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

  const byline = post.authors
    .map((a) => a.user.name)
    .filter(Boolean)
    .join(", ");
  const content = renderToReactElement({
    content: post.currentRevision.doc as JSONContent,
    extensions: contentExtensions,
  });

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <SiteHeader />
      <main style={{ padding: "1rem" }}>
        <h1>{post.currentRevision.title}</h1>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          {byline && `By ${byline} — `}
          {post.publishedAt?.toLocaleDateString()}
        </p>
        <article className={proseStyles.prose}>{content}</article>
        <p>
          <Link href="/">← Back to all posts</Link>
        </p>
      </main>
    </div>
  );
}
