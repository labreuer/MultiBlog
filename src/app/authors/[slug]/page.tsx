import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { userByOldSlug } from "@/lib/user-slug";
import { publishedPostWhere } from "@/lib/post-status";
import { postListOrderBy } from "@/lib/post-pages";
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
    orderBy: postListOrderBy,
    // The shared listing shows a byline, so a co-authored post now names its
    // other authors here too (PLAN.md §21h) — before, this page had none.
    include: postListingInclude,
  });

  return { user, posts };
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
    // An old slug goes on to the account's current one (userByOldSlug, which
    // the wiki's /wiki/@<old-slug>/ and MCP's readAuthor share), a live
    // account's only.
    const moved = await userByOldSlug(slug);
    if (moved) {
      permanentRedirect(`/authors/${moved.slug}`);
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
