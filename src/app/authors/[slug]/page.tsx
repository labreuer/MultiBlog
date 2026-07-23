import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { publishedPostWhere } from "@/lib/post-status";
import PostEditBadge from "@/components/PostEditBadge";
import styles from "./page.module.css";

export const revalidate = 60;

async function getAuthorWithPosts(slug: string) {
  const user = await prisma.user.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!user) {
    return null;
  }

  const posts = await prisma.post.findMany({
    where: { ...publishedPostWhere(), authors: { some: { userId: user.id } } },
    orderBy: { publishedAt: "desc" },
    include: {
      publishRevision: { select: { title: true, doc: true } },
      authors: { select: { userId: true } },
      revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { createdAt: true } },
      collab: { select: { updatedAt: true } },
    },
  });

  return { user, posts };
}

// Falls back to UserSlugHistory when `slug` isn't any user's current slug —
// old author links 301 to wherever that user lives now instead of 404ing.
// Mirrors [slug]/page.tsx's resolveRedirectSlug for posts; the nested `user`
// filter needs its own deletedByUserId check since src/lib/prisma.ts's
// soft-delete extension only wraps top-level user/post operations.
async function resolveRedirectSlug(slug: string): Promise<string | null> {
  const entry = await prisma.userSlugHistory.findFirst({
    where: { slug, user: { deletedByUserId: null } },
    select: { user: { select: { slug: true } } },
  });
  return entry?.user.slug ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const author = await getAuthorWithPosts(slug);
  if (!author) {
    return {};
  }
  return { title: author.user.name ?? "Author" };
}

export default async function AuthorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const author = await getAuthorWithPosts(slug);
  if (!author) {
    const redirectSlug = await resolveRedirectSlug(slug);
    if (redirectSlug) {
      permanentRedirect(`/authors/${redirectSlug}`);
    }
    notFound();
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <main style={{ padding: "1rem" }}>
        <h1>{author.user.name ?? "Author"}</h1>
        {author.posts.length === 0 ? (
          <p style={{ color: "#666" }}>No published posts yet.</p>
        ) : (
          author.posts.map((post) => {
            const excerpt = post.publishRevision ? extractText(post.publishRevision.doc).slice(0, 200) : "";
            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid #eee" }}>
                <h2 className={styles.postHeading}>
                  <Link href={`/${post.slug}`} className={styles.titleLink}>
                    {post.publishRevision?.title ?? post.title}
                  </Link>
                  <PostEditBadge
                    postId={post.id}
                    authorUserIds={post.authors.map((a) => a.userId)}
                    latestRevisionAt={post.revisions[0]?.createdAt.toISOString() ?? null}
                    collabUpdatedAt={post.collab?.updatedAt.toISOString() ?? null}
                  />
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
