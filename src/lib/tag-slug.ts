import { prismaIncludingDeleted } from "@/lib/prisma";
import { slugify } from "@/lib/slug";

// PLAN.md §20c — tag slugs, with **their own uniqueness namespace**: a
// tag, a doc, a file and a post may all carry the same slug and resolve to
// four different URLs, since /tag/*, /doc/*, /pdf/* and /yyyy/mm/dd/* can't
// collide. So `tagSlugInUse` checks `tag` and its history, and nothing else.
//
// **A re-slugged term keeps its old slug in `tag_slug_history`**
// (docs/MCP.md §11), the shape of the other four kinds' histories: an MCP
// client holds `/tag/<slug>` URLs from earlier reads, and /tag/[slug] follows
// a past slug as the other reading routes follow theirs. A slug in history
// stays reserved, so it never comes to name another term.
//
// The uniqueness Prisma *cannot* express is the important half: a hand-written
// `CREATE UNIQUE INDEX … ON tag (lower(name))` in add_tags, because
// slug uniqueness alone would admit "Epistemology" and "epistemology" as two
// distinct terms. `tagNameInUse` below is the friendly-error face of it.

async function tagSlugInUse(slug: string, excludeTagId?: string): Promise<boolean> {
  // prismaIncludingDeleted, for the reason uniquePostSlug/uniqueUserSlug use
  // it: a slug stays DB-unique even for a soft-deleted row, so pretending one
  // is free would trade a friendly "already exists" for a raw P2002 at create
  // time.
  const [live, historic] = await Promise.all([
    prismaIncludingDeleted.tag.findFirst({
      where: excludeTagId ? { slug, id: { not: excludeTagId } } : { slug },
      select: { id: true },
    }),
    prismaIncludingDeleted.tagSlugHistory.findFirst({
      where: excludeTagId ? { slug, tagId: { not: excludeTagId } } : { slug },
      select: { id: true },
    }),
  ]);
  return live !== null || historic !== null;
}

export async function uniqueTagSlug(name: string, excludeTagId?: string): Promise<string> {
  const base = slugify(name, "tag");
  let candidate = base;
  let suffix = 2;
  while (await tagSlugInUse(candidate, excludeTagId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Whether some other term already holds this name, compared **case-insensitively**
 * — the application-side face of the `tag_name_lower_key` index.
 *
 * Checking here rather than catching P2002 is only about the message: the index
 * is what actually guarantees it, and a concurrent create can still lose there.
 * The action reports both the same way.
 *
 * Includes soft-deleted terms, for the same reason `tagSlugInUse` does —
 * a deleted term still holds its name until it is restored or purged, and the
 * index does not filter on `deleted_at` either.
 */
export async function tagNameInUse(name: string, excludeTagId?: string): Promise<boolean> {
  const existing = await prismaIncludingDeleted.tag.findFirst({
    where: {
      name: { equals: name.trim(), mode: "insensitive" },
      ...(excludeTagId ? { id: { not: excludeTagId } } : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Changes a term's slug, recording the old one in TagSlugHistory so its
 * `/tag/…` URL still lands (docs/MCP.md §11) — changeDocSlug's twin. A slug
 * this term held before comes back out of its history rather than being
 * refused. No-ops when the slug is unchanged.
 */
export async function changeTagSlug(tagId: string, slugInput: string): Promise<string> {
  const slug = slugify(slugInput, "tag");
  return prismaIncludingDeleted.$transaction(async (tx) => {
    const tag = await tx.tag.findUnique({ where: { id: tagId }, select: { slug: true } });
    if (!tag) throw new Error("Tag not found.");
    if (tag.slug === slug) return slug;
    if (await tagSlugInUse(slug, tagId)) throw new Error(`The slug "${slug}" is already in use.`);
    await tx.tagSlugHistory.deleteMany({ where: { tagId, slug } });
    await tx.tagSlugHistory.create({ data: { tagId, slug: tag.slug } });
    await tx.tag.update({ where: { id: tagId }, data: { slug } });
    return slug;
  });
}

/** The term a past slug now belongs to, for /tag/[slug]'s miss: its current slug, or null. */
export async function tagSlugFromHistory(slug: string): Promise<string | null> {
  const entry = await prismaIncludingDeleted.tagSlugHistory.findUnique({
    where: { slug },
    select: { tag: { select: { slug: true, deletedAt: true } } },
  });
  return entry && entry.tag.deletedAt === null ? entry.tag.slug : null;
}
