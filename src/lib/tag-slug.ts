import { prismaIncludingDeleted } from "@/lib/prisma";
import { slugify, RESERVED_SLUGS } from "@/lib/slug";

// PLAN.md §20c — tag slugs, with **their own uniqueness namespace**: a
// tag, a doc, a file and a post may all carry the same slug and resolve to
// four different URLs, since /tag/*, /doc/*, /pdf/* and the post catch-all
// can't collide. So `tagSlugInUse` checks `tag` and nothing else.
//
// `tag` and `tags` were added to RESERVED_SLUGS (src/lib/slug.ts) when
// this landed: those are new top-level route segments, so a *post* slug
// matching either would be shadowed by the static route. That reservation is
// about posts, not about tags — a tag slug can't collide with its own
// route segment because it lives one level down.
//
// **No slug history table in v1**, deliberately (§20i). Docs, posts, files and
// users each have one because their URLs are shared outward and a rename must
// not break an inbound link; a tag's browse page is an internal navigation
// aid before it is a citable address. Renaming one breaks inbound /tag/…
// links until it earns a history table, and the named trigger condition for
// building one is the first time a tag URL is shared somewhere durable.
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
  const live = await prismaIncludingDeleted.tag.findFirst({
    where: excludeTagId ? { slug, id: { not: excludeTagId } } : { slug },
    select: { id: true },
  });
  return live !== null;
}

export async function uniqueTagSlug(name: string, excludeTagId?: string): Promise<string> {
  const base = slugify(name, "tag");
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-tag` : base;
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
