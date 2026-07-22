import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify, RESERVED_SLUGS } from "@/lib/slug";

// A slug counts as "in use" if it's any post's *current* slug, or sitting in
// any post's history as a redirect source — otherwise a new/renamed post
// could claim a slug that still 301s an old link to a different post.
async function postSlugInUse(
  slug: string,
  client: Prisma.TransactionClient = prismaIncludingDeleted,
): Promise<boolean> {
  const [live, historic] = await Promise.all([
    client.post.findUnique({ where: { slug }, select: { id: true } }),
    client.postSlugHistory.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  return live !== null || historic !== null;
}

export async function uniquePostSlug(title: string): Promise<string> {
  const base = slugify(title);
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-post` : base;
  let suffix = 2;
  while (await postSlugInUse(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

// Renames a post's slug, recording the old one in PostSlugHistory so
// existing links/bookmarks can still be resolved (see [slug]/page.tsx's
// history fallback). No-ops if newSlugInput normalizes to the post's
// current slug.
export async function changePostSlug(postId: string, newSlugInput: string): Promise<string> {
  const newSlug = slugify(newSlugInput);
  if (RESERVED_SLUGS.has(newSlug)) {
    throw new Error(`"${newSlug}" is a reserved path and can't be used as a post slug.`);
  }

  return prismaIncludingDeleted.$transaction(async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId }, select: { slug: true } });
    if (!post) {
      throw new Error("Post not found.");
    }
    if (post.slug === newSlug) {
      return newSlug;
    }
    if (await postSlugInUse(newSlug, tx)) {
      throw new Error(`Slug "${newSlug}" is already in use.`);
    }
    await tx.postSlugHistory.create({ data: { postId, slug: post.slug } });
    await tx.post.update({ where: { id: postId }, data: { slug: newSlug } });
    return newSlug;
  });
}
