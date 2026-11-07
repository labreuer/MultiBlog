import { scheduleMentionRefresh } from "@/lib/entity-chips/refresh";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify, REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";

/**
 * Handles no account may have. `me` is the searcher in a mention filter
 * (`mentions=me`, or `@me` in the search box: docs/MENTIONS.md, "Search"), and
 * an account called that could never be searched for. Nothing else is
 * reserved: author slugs live under /authors/[slug], which has no sibling
 * static routes to collide with, unlike a post's top-level /[slug].
 */
const RESERVED_USER_SLUGS: ReadonlySet<string> = new Set(["me"]);

// A slug counts as "in use" if it's reserved (above), any user's *current*
// slug, or sitting in any user's history as a redirect source — mirrors
// post-slug.ts's postSlugInUse for Post. excludeUserId: see postSlugInUse's
// excludePostId.
async function userSlugInUse(
  slug: string,
  client: Prisma.TransactionClient = prismaIncludingDeleted,
  excludeUserId?: string,
): Promise<boolean> {
  if (RESERVED_USER_SLUGS.has(slug)) return true;
  const [live, historic] = await Promise.all([
    client.user.findFirst({
      where: excludeUserId ? { slug, id: { not: excludeUserId } } : { slug },
      select: { id: true },
    }),
    client.userSlugHistory.findFirst({
      where: excludeUserId ? { slug, userId: { not: excludeUserId } } : { slug },
      select: { id: true },
    }),
  ]);
  return live !== null || historic !== null;
}

// excludeUserId: see uniquePostSlug's excludePostId — omitted for the normal
// sign-up path, passed by the slug-management page to preview what
// name/email-derived slug this user would get today.
export async function uniqueUserSlug(name: string | null, email: string, excludeUserId?: string): Promise<string> {
  const base = slugify(name || email.split("@")[0], "user");
  let candidate = base;
  let suffix = 2;
  while (await userSlugInUse(candidate, prismaIncludingDeleted, excludeUserId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

// Renames a user's slug, recording the old one in UserSlugHistory so
// existing /authors links can still be resolved (see
// authors/[slug]/page.tsx's history fallback). No-ops if newSlugInput
// normalizes to the user's current slug.
export async function changeUserSlug(userId: string, newSlugInput: string): Promise<string> {
  const newSlug = slugify(newSlugInput, "user");

  const slug = await prismaIncludingDeleted.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { slug: true } });
    if (!user) {
      throw new Error("User not found.");
    }
    if (user.slug === newSlug) {
      return newSlug;
    }
    if (RESERVED_USER_SLUGS.has(newSlug)) {
      throw new Error(`Url "${newSlug}" is reserved.`);
    }
    if (await userSlugInUse(newSlug, tx)) {
      throw new Error(`Url "${newSlug}" is already in use.`);
    }
    await tx.userSlugHistory.create({ data: { userId, slug: user.slug } });
    await tx.user.update({ where: { id: userId }, data: { slug: newSlug } });
    return newSlug;
  });
  // A handle is what a mention shows for a nameless account, and what tells
  // apart two people of one name (docs/MENTIONS.md, "Refresh"). After the
  // transaction, so the refresh reads the new one.
  scheduleMentionRefresh([userId]);
  return slug;
}

// Swaps a user's slug back to its most recent past one — mirrors
// post-slug.ts's revertPostSlug (see its comment for both why consuming the
// history row directly is unconditionally available, and the
// REVERT_DISCARD_WINDOW_MS no-trace-if-recent behavior).
export async function revertUserSlug(userId: string): Promise<string> {
  const slug = await prismaIncludingDeleted.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { slug: true } });
    if (!user) {
      throw new Error("User not found.");
    }
    const lastHistory = await tx.userSlugHistory.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    if (!lastHistory) {
      throw new Error("No past url to revert to.");
    }
    await tx.userSlugHistory.delete({ where: { id: lastHistory.id } });
    if (Date.now() - lastHistory.createdAt.getTime() >= REVERT_DISCARD_WINDOW_MS) {
      await tx.userSlugHistory.create({ data: { userId, slug: user.slug } });
    }
    await tx.user.update({ where: { id: userId }, data: { slug: lastHistory.slug } });
    return lastHistory.slug;
  });
  scheduleMentionRefresh([userId]);
  return slug;
}
