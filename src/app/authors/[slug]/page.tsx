import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { publishedPostWhere } from "@/lib/post-status";
import { resolveAvatarSrc } from "@/lib/avatar-url";
import Avatar from "@/components/Avatar";
import PostListing, { postListingInclude } from "@/components/PostListing";
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
    // The shared listing shows a byline, so a co-authored post now names its
    // other authors here too (PLAN.md §21h) — before, this page had none.
    include: postListingInclude,
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
  return { title: `@${author.user.name ?? "Author"}` };
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
        <PostListing posts={author.posts} emptyMessage="No published posts yet." />
      </main>
    </div>
  );
}
