import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify } from "@/lib/slug";

// A slug counts as "in use" if it's any user's *current* slug, or sitting in
// any user's history as a redirect source — mirrors post-slug.ts's postSlugInUse for
// Post. No reserved-word set: unlike post slugs (top-level /[slug] route),
// author slugs live under /authors/[slug], which has no sibling static
// routes to collide with.
async function userSlugInUse(
  slug: string,
  client: Prisma.TransactionClient = prismaIncludingDeleted,
): Promise<boolean> {
  const [live, historic] = await Promise.all([
    client.user.findUnique({ where: { slug }, select: { id: true } }),
    client.userSlugHistory.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  return live !== null || historic !== null;
}

export async function uniqueUserSlug(name: string | null, email: string): Promise<string> {
  const base = slugify(name || email.split("@")[0], "user");
  let candidate = base;
  let suffix = 2;
  while (await userSlugInUse(candidate)) {
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

  return prismaIncludingDeleted.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { slug: true } });
    if (!user) {
      throw new Error("User not found.");
    }
    if (user.slug === newSlug) {
      return newSlug;
    }
    if (await userSlugInUse(newSlug, tx)) {
      throw new Error(`Slug "${newSlug}" is already in use.`);
    }
    await tx.userSlugHistory.create({ data: { userId, slug: user.slug } });
    await tx.user.update({ where: { id: userId }, data: { slug: newSlug } });
    return newSlug;
  });
}
