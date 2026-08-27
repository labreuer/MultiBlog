import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canManageDocs } from "@/lib/role-checks";
import { canCurateTags } from "@/lib/tag-authz";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parseTagsFilters, type TagsFilters, type TagsSortKey } from "@/lib/tags-query";
import type { SortColumn } from "@/lib/table-sort";
import TagsTable from "@/components/TagsTable";

export const metadata: Metadata = { title: "Tags" };

// PLAN.md §20d — the tag vocabulary, through the §16 admin-table kit.
//
// **Two gates, not one.** The page itself is `canManageDocs` (AUTHOR and up),
// which is the same bar every other admin listing sets — an admin table is an
// editorial surface, and inventing a seventh visibility tier for this one would
// be a UI regression before it was a security improvement. Acting on a *term*
// is `canCurateTags` (ADMIN/EDITOR), threaded into the table as `canCurate`.
// An AUTHORIZED user can still create and apply terms; they just do it from the
// tagger on an object page, and browse the vocabulary at /tag/[slug].
//
// **No per-viewer row scoping**, unlike /docs and /files, and deliberately: a
// *term* carries no visibility of its own. Knowing that "Epistemology" exists
// reveals nothing about what has been tagged with it, and everything that
// *would* reveal something — which docs, which posts — is behind
// /tag/[slug], which wears each type's own permission predicate per row.
// The usage counts here come from `tag_metrics`, which is likewise about
// terms rather than content; §20d says the reader-facing, permission-filtered
// counts never come from that view, and this page is not a reader.

function buildFilterWhere(filters: TagsFilters): Prisma.TagWhereInput {
  const where: Prisma.TagWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  // Searches the term *and* its description: which one someone remembers when
  // hunting for a near-duplicate is not predictable, and finding the
  // near-duplicate is the whole reason to search a vocabulary.
  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: "insensitive" } },
      { description: { contains: filters.q, mode: "insensitive" } },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<TagsSortKey>[]): Prisma.TagOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.TagOrderByWithRelationInput => {
    switch (key) {
      case "name":
        return { name: dir };
      case "description":
        return { description: { sort: dir, nulls: "last" } };
      // The six through the tag_metrics view — the same expressions the
      // cells show, so displayed and sorted can't drift (§16e).
      //
      // `nulls: "last"` on every one of them, and it is not decoration. A
      // tag nobody has used has no view row, so the LEFT JOIN yields NULL
      // in these columns — and a plain `DESC` puts NULLs *first* in Postgres,
      // which would make "sort by most used" lead with the terms nobody has
      // ever applied. Unused sorts last in both directions here, which is what
      // anyone reading the column means. (The view columns are declared
      // nullable in schema.prisma precisely so Prisma accepts this form; see
      // TagMetrics' comment.)
      case "assignments":
        return { metrics: { assignmentCount: { sort: dir, nulls: "last" } } };
      case "docs":
        return { metrics: { docCount: { sort: dir, nulls: "last" } } };
      case "posts":
        return { metrics: { postCount: { sort: dir, nulls: "last" } } };
      case "files":
        return { metrics: { fileCount: { sort: dir, nulls: "last" } } };
      case "annotations":
        return { metrics: { annotationCount: { sort: dir, nulls: "last" } } };
      case "lastUsed":
        return { metrics: { lastUsedAt: { sort: dir, nulls: "last" } } };
      case "createdBy":
        return { createdBy: { name: { sort: dir, nulls: "last" } } };
      case "created":
        return { createdAt: dir };
      case "slug":
        return { slug: dir };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManageDocs(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Tags</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to browse the tag table.</p>
      </main>
    );
  }

  const urlSearchParams = toURLSearchParams(await searchParams);
  const prefs = await getTablePrefs(session.user.id, "tags");
  const filters = parseTagsFilters(urlSearchParams, prefs);
  const where = buildFilterWhere(filters);

  const [tags, totalCount] = await Promise.all([
    // prismaIncludingDeleted, so the show-deleted toggle can list a soft-deleted
    // term in order to offer restoring it — the same reason /files uses it.
    prismaIncludingDeleted.tag.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        createdAt: true,
        deletedByUserId: true,
        deletedAt: true,
        // Read from the same view that sorts them (§16e).
        metrics: {
          select: {
            assignmentCount: true,
            docCount: true,
            postCount: true,
            fileCount: true,
            annotationCount: true,
            lastUsedAt: true,
          },
        },
        createdBy: { select: { name: true, email: true } },
      },
    }),
    prismaIncludingDeleted.tag.count({ where }),
  ]);

  const rows = tags.map((tag) => ({
    id: tag.id,
    slug: tag.slug,
    name: tag.name,
    description: tag.description ?? "",
    // No view row at all means the term has never been applied, so zero
    // everywhere and a blank Last used.
    assignmentCount: tag.metrics?.assignmentCount ?? 0,
    docCount: tag.metrics?.docCount ?? 0,
    postCount: tag.metrics?.postCount ?? 0,
    fileCount: tag.metrics?.fileCount ?? 0,
    annotationCount: tag.metrics?.annotationCount ?? 0,
    lastUsedAt: tag.metrics?.lastUsedAt ?? null,
    createdByName: tag.createdBy.name ?? tag.createdBy.email,
    createdAt: tag.createdAt,
    deletedAt: tag.deletedAt,
    deleted: tag.deletedByUserId !== null,
  }));

  return (
    <main style={{ maxWidth: 1100, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Tags</h1>
      <TagsTable
        rows={rows}
        totalCount={totalCount}
        filters={filters}
        prefs={prefs}
        canCurate={canCurateTags(session.user.role)}
      />
    </main>
  );
}
