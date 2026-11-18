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

/**
 * Whether `slug` is free for a new account: not reserved, nobody's slug,
 * deleted accounts included, and in nobody's history. For a caller that
 * picks its own candidates, as a bot made at Approve does (src/lib/bots.ts).
 */
export async function isUserSlugFree(slug: string): Promise<boolean> {
  return !(await userSlugInUse(slug));
}

/**
 * The account an old slug was left by, through user_slug_history: what
 * /authors/, MCP's readAuthor and the wiki's `/wiki/@<old-slug>/` each send an
 * old link on to, so the three share one lookup. A deleted account's only
 * with `includeDeleted`, which the wiki asks so that a deleted person's pages
 * stay where they were (docs/WIKI.md "URLs"); /authors/ 404s for one. Each
 * wiki redirect it feeds is a 307, since an old slug can be freed
 * (deleteUserSlugHistory) or taken back (revertUserSlug); /authors/' own
 * stays a 308 (docs/BLOG.md §3).
 */
export async function userByOldSlug(
  slug: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<{ id: string; slug: string; name: string | null; deleted: boolean } | null> {
  const entry = await prismaIncludingDeleted.userSlugHistory.findFirst({
    where: { slug, ...(opts.includeDeleted ? {} : { user: { deletedByUserId: null } }) },
    select: { user: { select: { id: true, slug: true, name: true, deletedByUserId: true } } },
  });
  if (!entry) return null;
  const { deletedByUserId, ...user } = entry.user;
  return { ...user, deleted: deletedByUserId !== null };
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
// normalizes to the user's current slug. A slug this user held before comes
// back out of their own history, as revertUserSlug's does, rather than being
// refused as in use: uniqueUserSlug, which SlugManager's "use standard" asks,
// passes over the user's own rows and so can offer one.
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
    if (await userSlugInUse(newSlug, tx, userId)) {
      throw new Error(`Url "${newSlug}" is already in use.`);
    }
    await tx.userSlugHistory.deleteMany({ where: { userId, slug: newSlug } });
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
