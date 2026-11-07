import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { canViewReferences, canWriteReferences } from "@/lib/role-checks";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parseReferencesFilters, type ReferencesFilters, type ReferencesSortKey } from "@/lib/references-query";
import type { SortColumn } from "@/lib/table-sort";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import ReferencesTable from "@/components/ReferencesTable";
import ReferenceImport from "@/components/ReferenceImport";
import { staffDisplayNameOf } from "@/lib/display-name";

export const metadata: Metadata = { title: "References" };

// docs/CITATIONS.md, "Pages" — the reference library, through the admin
// table kit.
//
// **For signed-in members** (`canViewReferences`), and with no per-viewer row
// scoping: a reference's record is public, on its own page, so there is
// nothing here one member may see and another may not. What a member can't
// do, unless an AUTHOR or above, is change it (`canWrite`).
//
// On the base client: `reference` is not in the soft-delete extension, and
// the show-deleted toggle lists a deleted one so it can be restored.

/** The ids whose search vector matches every word typed, each as a prefix: what the search box narrows to. */
async function matchingIds(q: string): Promise<string[] | null> {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const tsquery = words.map((word) => `${word}:*`).join(" & ");
  const rows = await prismaIncludingDeleted.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT r.id FROM "reference" r WHERE r.search_vector @@ to_tsquery('public.english_unaccent', ${tsquery})`);
  return rows.map((row) => row.id);
}

function buildOrderBy(sort: SortColumn<ReferencesSortKey>[]): Prisma.ReferenceOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.ReferenceOrderByWithRelationInput => {
    switch (key) {
      case "key":
        return { key: dir };
      case "short":
        return { short: { sort: dir, nulls: "last" } };
      // The three through the reference_listing view: the same expressions
      // the cells show, so displayed and sorted can't drift. Blank sorts
      // last either way, as an undated or anonymous work is read.
      case "people":
        return { listing: { people: { sort: dir, nulls: "last" } } };
      case "year":
        return { listing: { year: { sort: dir, nulls: "last" } } };
      case "title":
        return { listing: { title: { sort: dir, nulls: "last" } } };
      case "file":
        return { file: { title: dir } };
      case "created":
        return { createdAt: dir };
      case "createdBy":
        return { createdBy: { name: { sort: dir, nulls: "last" } } };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

async function buildWhere(filters: ReferencesFilters): Promise<Prisma.ReferenceWhereInput> {
  const where: Prisma.ReferenceWhereInput = {};
  if (!filters.deleted) where.deletedAt = null;
  if (filters.q) {
    const ids = await matchingIds(filters.q);
    if (ids) where.id = { in: ids };
  }
  return where;
}

export default async function ReferencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Above the gate, so an anonymous visitor's callbackUrl keeps the filters
  // they arrived with: this table's whole state lives in the querystring.
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery("/references", urlSearchParams)));
  }
  if (!canViewReferences(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>References</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to browse the reference library.</p>
      </main>
    );
  }

  const prefs = await getTablePrefs(session.user.id, "references");
  const filters = parseReferencesFilters(urlSearchParams, prefs);
  const where = await buildWhere(filters);

  const [references, totalCount] = await Promise.all([
    prismaIncludingDeleted.reference.findMany({
      where,
      orderBy: [...buildOrderBy(filters.sort), { key: "asc" }],
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      select: {
        id: true,
        key: true,
        short: true,
        createdAt: true,
        deletedAt: true,
        // Read from the same view that sorts them.
        listing: { select: { title: true, people: true, year: true } },
        file: { select: { slug: true, title: true, deletedByUserId: true } },
        createdBy: { select: { name: true, email: true } },
      },
    }),
    prismaIncludingDeleted.reference.count({ where }),
  ]);

  const canWrite = canWriteReferences(session.user.role);
  const rows = references.map((reference) => ({
    id: reference.id,
    key: reference.key,
    short: reference.short ?? "",
    people: reference.listing?.people ?? "",
    year: reference.listing?.year ?? null,
    title: reference.listing?.title ?? "",
    // A file reached through a relation isn't filtered by the soft-delete extension, so a deleted one is left out by hand.
    file: reference.file && reference.file.deletedByUserId === null ? { slug: reference.file.slug, title: reference.file.title } : null,
    createdByName: staffDisplayNameOf(reference.createdBy, session.user.role),
    createdAt: reference.createdAt,
    deletedAt: reference.deletedAt,
    deleted: reference.deletedAt !== null,
  }));

  return (
    <main style={{ maxWidth: 1100, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>References</h1>
      {canWrite && <ReferenceImport />}
      <ReferencesTable rows={rows} totalCount={totalCount} filters={filters} prefs={prefs} canWrite={canWrite} />
    </main>
  );
}
