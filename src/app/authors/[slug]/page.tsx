import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { publishedPostWhere } from "@/lib/post-status";
import { resolveAvatarSrc } from "@/lib/avatar-url";
import Avatar from "@/components/Avatar";
import styles from "./page.module.css";

export const revalidate = 60;

async function getAuthorWithPosts(slug: string) {
  const user = await prisma.user.findUnique({
    where: { slug },
    // avatar.hash only, never the bytes — see PLAN.md §17n for why the
    // avatar is its own table and what a wide select on `user` would drag in.
    select: {
      id: true,
      name: true,
      image: true,
      color: true,
      adminInitials: true,
      avatar: { select: { hash: true } },
    },
  });
  if (!user) {
    return null;
  }

  const posts = await prisma.post.findMany({
    where: { ...publishedPostWhere(), authors: { some: { userId: user.id } } },
    orderBy: { publishedAt: "desc" },
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
        <div className={styles.authorHeading}>
          <Avatar
            src={resolveAvatarSrc({
              userId: author.user.id,
              avatarHash: author.user.avatar?.hash,
              image: author.user.image,
            })}
            color={author.user.color}
            initials={author.user.adminInitials}
            size={64}
          />
          <h1>{author.user.name ?? "Author"}</h1>
        </div>
        {author.posts.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No published posts yet.</p>
        ) : (
          author.posts.map((post) => {
            const excerpt = post.proseJson ? extractText(post.proseJson).slice(0, 200) : "";
            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                <h2 className={styles.postHeading}>
                  <Link href={`/${post.slug}`} className={styles.titleLink}>
                    {post.title}
                  </Link>
                </h2>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>{post.publishedAt?.toLocaleDateString()}</p>
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
