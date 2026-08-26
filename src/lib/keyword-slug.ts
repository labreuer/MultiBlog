import { prismaIncludingDeleted } from "@/lib/prisma";
import { slugify, RESERVED_SLUGS } from "@/lib/slug";

// PLAN.md §20c — keyword slugs, with **their own uniqueness namespace**: a
// keyword, a doc, a file and a post may all carry the same slug and resolve to
// four different URLs, since /keyword/*, /doc/*, /pdf/* and the post catch-all
// can't collide. So `keywordSlugInUse` checks `keyword` and nothing else.
//
// `keyword` and `keywords` were added to RESERVED_SLUGS (src/lib/slug.ts) when
// this landed: those are new top-level route segments, so a *post* slug
// matching either would be shadowed by the static route. That reservation is
// about posts, not about keywords — a keyword slug can't collide with its own
// route segment because it lives one level down.
//
// **No slug history table in v1**, deliberately (§20i). Docs, posts, files and
// users each have one because their URLs are shared outward and a rename must
// not break an inbound link; a keyword's browse page is an internal navigation
// aid before it is a citable address. Renaming one breaks inbound /keyword/…
// links until it earns a history table, and the named trigger condition for
// building one is the first time a keyword URL is shared somewhere durable.
//
// The uniqueness Prisma *cannot* express is the important half: a hand-written
// `CREATE UNIQUE INDEX … ON keyword (lower(name))` in add_keywords, because
// slug uniqueness alone would admit "Epistemology" and "epistemology" as two
// distinct terms. `keywordNameInUse` below is the friendly-error face of it.

async function keywordSlugInUse(slug: string, excludeKeywordId?: string): Promise<boolean> {
  // prismaIncludingDeleted, for the reason uniquePostSlug/uniqueUserSlug use
  // it: a slug stays DB-unique even for a soft-deleted row, so pretending one
  // is free would trade a friendly "already exists" for a raw P2002 at create
  // time.
  const live = await prismaIncludingDeleted.keyword.findFirst({
    where: excludeKeywordId ? { slug, id: { not: excludeKeywordId } } : { slug },
    select: { id: true },
  });
  return live !== null;
}

export async function uniqueKeywordSlug(name: string, excludeKeywordId?: string): Promise<string> {
  const base = slugify(name, "keyword");
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-keyword` : base;
  let suffix = 2;
  while (await keywordSlugInUse(candidate, excludeKeywordId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Whether some other term already holds this name, compared **case-insensitively**
 * — the application-side face of the `keyword_name_lower_key` index.
 *
 * Checking here rather than catching P2002 is only about the message: the index
 * is what actually guarantees it, and a concurrent create can still lose there.
 * The action reports both the same way.
 *
 * Includes soft-deleted terms, for the same reason `keywordSlugInUse` does —
 * a deleted term still holds its name until it is restored or purged, and the
 * index does not filter on `deleted_at` either.
 */
export async function keywordNameInUse(name: string, excludeKeywordId?: string): Promise<boolean> {
  const existing = await prismaIncludingDeleted.keyword.findFirst({
    where: {
      name: { equals: name.trim(), mode: "insensitive" },
      ...(excludeKeywordId ? { id: { not: excludeKeywordId } } : {}),
    },
    select: { id: true },
  });
  return existing !== null;
}
