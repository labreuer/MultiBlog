import { prisma } from "@/lib/prisma";
import { BYLINE_ELIGIBLE_ROLES } from "@/lib/role-checks";
import type { AuthorMode } from "@/lib/table-query";

// The /docs and /posts "Authors" filter (PLAN.md §16) — a checkbox panel of
// eligible authors plus a combining mode, both mirrored into the querystring
// like every other criterion on those tables. This module owns the two
// server-only pieces both pages need identically: the option list, and the
// four modes' Prisma `where` semantics.

export type AuthorOption = { slug: string; label: string };

// Every ADMIN/EDITOR/AUTHOR who could hold a byline, for the filter panel's
// checkbox list. Uses `prisma` (the soft-delete-filtered client), not
// `prismaIncludingDeleted` — a deleted account is off the site, so listing it
// as a filterable author would be noise; a URL naming a since-deleted user's
// slug degrades to "unknown, drop it" the same way a renamed slug does
// (parseSlugListParam, table-query.ts).
//
// Sorted in JS, not via Prisma `orderBy`: the sort key is `name ?? email`,
// which orderBy can't express — `[{name:"asc"},{email:"asc"}]` puts every
// named user before every unnamed one instead of interleaving them. The list
// is small and read once per page load, so there's no cost argument for
// pushing this into SQL the way there is for a real column sort (CLAUDE.md).
export async function listAuthorFilterOptions(viewerId: string): Promise<AuthorOption[]> {
  const users = await prisma.user.findMany({
    where: { role: { in: BYLINE_ELIGIBLE_ROLES } },
    select: { id: true, slug: true, name: true, email: true },
  });

  return users
    .map((u) => ({
      slug: u.slug,
      // The same name-or-email fallback /docs' "Updated by" and /comments'
      // "Changed by" already use, so one person reads the same way
      // everywhere in the admin UI. "(me)" is appended before sorting so the
      // label that gets ordered is the label that's shown.
      label: `${u.name ?? u.email}${u.id === viewerId ? " (me)" : ""}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

// A generic relation-filter shape loose enough to satisfy
// Prisma.DocWhereInput's, Prisma.PostWhereInput's and
// Prisma.StoredFileWhereInput's `authors` field — all three are a to-many
// DocAuthor/PostAuthor/FileAuthor relation with a nested `user.slug`, so one
// structural type serves every call site without importing any generated type
// here. /files (PLAN.md §19) reuses this untouched, which is the payoff for
// having written it structurally in the first place.
type AuthorRelationWhere = {
  authors?: {
    some?: { user: { slug: { in: string[] } | string } };
    every?: { user: { slug: { in: string[] } } };
    none?: { user: { slug: { in: string[] } } };
  };
  AND?: AuthorRelationWhere[];
};

// The four modes, given the sanitized (known-slug, possibly empty) selection
// a page's parser already produced. An empty selection is no filter at all,
// whatever the mode says — the mode is how a selection combines, so with
// nothing selected there is nothing to combine. This is also what makes a
// bookmarked ?authorMode= with every ?authors= slug gone stale degrade to the
// ordinary listing rather than an empty one.
//
// EXACTLY vs. a soft-deleted co-author: a row bylined to a live user *and* a
// soft-deleted one keeps both join rows, but the deleted user never appears
// in listAuthorFilterOptions above, so they can't be checked — EXACTLY over
// the live user alone will not match that row, because its `every` clause
// still sees the deleted user's row. This is deliberate, not a bug to chase:
// the Author(s) column renders doc_metrics/post_metrics' byline, which
// string_aggs every join row regardless of the user's soft-delete state, so
// "fixing" `every` to ignore deleted users would make EXACTLY disagree with
// what the column next to it prints.
export function authorFilterWhere(slugs: string[], mode: AuthorMode): AuthorRelationWhere {
  if (slugs.length === 0) return {};

  switch (mode) {
    case "ANY":
      // At least one of them — one EXISTS regardless of how many are checked.
      return { authors: { some: { user: { slug: { in: slugs } } } } };

    case "ALL":
      // Every one of them, extras allowed. NOT `some: { in: slugs } }` (that's
      // ANY, an OR) and NOT `every` (that's "nobody outside the set", a
      // different question, vacuously true of an authorless row) — an AND of
      // one `some` per slug is the only spelling that means this.
      return { AND: slugs.map((slug) => ({ authors: { some: { user: { slug } } } })) };

    case "EXACTLY":
      // That byline and nobody else. The per-slug `some`s establish "all of
      // them are present"; `every` is the single extra clause that excludes a
      // row carrying an author beyond the checked set — the one thing that
      // distinguishes EXACTLY from ALL. `every` is vacuously true for a row
      // with zero authors, which can't slip through here: slugs is non-empty,
      // so the somes above already require at least slugs.length authors.
      return {
        AND: [
          ...slugs.map((slug) => ({ authors: { some: { user: { slug } } } })),
          { authors: { every: { user: { slug: { in: slugs } } } } },
        ],
      };

    case "NONE":
      // None of them wrote it. A row with no byline at all passes, correctly
      // — nobody checked wrote it either.
      return { authors: { none: { user: { slug: { in: slugs } } } } };
  }
}
