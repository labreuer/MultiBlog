import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import SiteHeader from "@/components/SiteHeader";

export const revalidate = 60;

async function getAuthorWithPosts(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!user) {
    return null;
  }

  const posts = await prisma.post.findMany({
    where: { status: "PUBLISHED", currentRevisionId: { not: null }, authors: { some: { userId: id } } },
    orderBy: { publishedAt: "desc" },
    include: { currentRevision: { select: { title: true, doc: true } } },
  });

  return { user, posts };
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const author = await getAuthorWithPosts(id);
  if (!author) {
    return {};
  }
  return { title: author.user.name ?? "Author" };
}

export default async function AuthorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const author = await getAuthorWithPosts(id);
  if (!author) {
    notFound();
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <SiteHeader />
      <main style={{ padding: "1rem" }}>
        <h1>{author.user.name ?? "Author"}</h1>
        {author.posts.length === 0 ? (
          <p style={{ color: "#666" }}>No published posts yet.</p>
        ) : (
          author.posts.map((post) => {
            const excerpt = post.currentRevision ? extractText(post.currentRevision.doc).slice(0, 200) : "";
            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid #eee" }}>
                <h2>
                  <Link href={`/${post.slug}`}>{post.currentRevision?.title ?? post.title}</Link>
                </h2>
                <p style={{ color: "#666", fontSize: "0.9rem" }}>{post.publishedAt?.toLocaleDateString()}</p>
                <p>
                  {excerpt}
                  {excerpt.length === 200 ? "…" : ""}
                </p>
              </article>
            );
          })
        )}
      </main>
    </div>
  );
}
