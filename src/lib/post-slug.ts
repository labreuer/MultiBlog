import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify, RESERVED_SLUGS, REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";

// A slug counts as "in use" if it's any post's *current* slug, or sitting in
// any post's history as a redirect source — otherwise a new/renamed post
// could claim a slug that still 301s an old link to a different post.
// excludePostId ignores excludePostId's own live slug/history rows — used by
// uniquePostSlug's SlugManager.tsx "what would the standard slug be" preview
// so a post doesn't spuriously collide with its own current reservation.
async function postSlugInUse(
  slug: string,
  client: Prisma.TransactionClient = prismaIncludingDeleted,
  excludePostId?: string,
): Promise<boolean> {
  const [live, historic] = await Promise.all([
    client.post.findFirst({
      where: excludePostId ? { slug, id: { not: excludePostId } } : { slug },
      select: { id: true },
    }),
    client.postSlugHistory.findFirst({
      where: excludePostId ? { slug, postId: { not: excludePostId } } : { slug },
      select: { id: true },
    }),
  ]);
  return live !== null || historic !== null;
}

// excludePostId: see postSlugInUse. Omitted for the normal creation path;
// passed by the slug-management page to preview what title-derived slug this
// post would get today, ignoring the slug/history rows it already owns.
export async function uniquePostSlug(title: string, excludePostId?: string): Promise<string> {
  const base = slugify(title);
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-post` : base;
  let suffix = 2;
  while (await postSlugInUse(candidate, prismaIncludingDeleted, excludePostId)) {
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
    throw new Error(`"${newSlug}" is a reserved path and can't be used as a post url.`);
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
      throw new Error(`Url "${newSlug}" is already in use.`);
    }
    await tx.postSlugHistory.create({ data: { postId, slug: post.slug } });
    await tx.post.update({ where: { id: postId }, data: { slug: newSlug } });
    return newSlug;
  });
}

// Swaps a post's slug back to its most recent past one — the one-click undo
// for changePostSlug, in place of a confirm/cancel gate before the change
// (see SlugManager.tsx). Consumes that history row rather than going through
// changePostSlug/postSlugInUse's general uniqueness check: the target slug
// is this same post's own reservation, so deleting the row it's already
// holding and re-creating one for the slug being reverted away from is both
// correct and unconditionally available — nothing else could have taken it
// in the meantime, since it was never freed.
//
// The slug being abandoned only gets a new history row if lastHistory (i.e.
// the abandoned slug's own go-live moment) is at least REVERT_DISCARD_WINDOW_MS
// old — a revert caught within that window undoes the change with no trace,
// on the theory that nothing could plausibly have linked to a slug that
// lived under an hour.
export async function revertPostSlug(postId: string): Promise<string> {
  return prismaIncludingDeleted.$transaction(async (tx) => {
    const post = await tx.post.findUnique({ where: { id: postId }, select: { slug: true } });
    if (!post) {
      throw new Error("Post not found.");
    }
    const lastHistory = await tx.postSlugHistory.findFirst({ where: { postId }, orderBy: { createdAt: "desc" } });
    if (!lastHistory) {
      throw new Error("No past url to revert to.");
    }
    await tx.postSlugHistory.delete({ where: { id: lastHistory.id } });
    if (Date.now() - lastHistory.createdAt.getTime() >= REVERT_DISCARD_WINDOW_MS) {
      await tx.postSlugHistory.create({ data: { postId, slug: post.slug } });
    }
    await tx.post.update({ where: { id: postId }, data: { slug: lastHistory.slug } });
    return lastHistory.slug;
  });
}
