import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { canManageDocs } from "@/lib/doc-authz";
import { canEditAnyPost } from "@/lib/authz";
import { createDoc } from "@/app/actions/docs";
import { docTitleOrFallback } from "@/lib/doc-title";
import { toURLSearchParams } from "@/lib/table-query";
import { getDefaultPageSize } from "@/lib/user-preferences";
import { parseDocsFilters, type DocsFilters, type DocsSortKey } from "@/lib/docs-query";
import type { SortColumn } from "@/lib/table-sort";
import DocsTable from "@/components/DocsTable";
import styles from "./page.module.css";

function buildFilterWhere(filters: DocsFilters): Prisma.DocWhereInput {
  const where: Prisma.DocWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) where.title = { contains: filters.q, mode: "insensitive" };
  return where;
}

function buildOrderBy(sort: SortColumn<DocsSortKey>[]): Prisma.DocOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.DocOrderByWithRelationInput => {
    switch (key) {
      case "title":
        return { title: dir };
      case "visibility":
        return { visibility: dir };
      case "created":
        return { createdAt: dir };
      case "deleted":
        // deletedByUserId is null for a live doc — nulls first when ascending
        // so live rows lead, matching every other admin table's convention
        // for this column.
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function DocsPage({
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
        <h1>Docs</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage docs.</p>
      </main>
    );
  }

  const urlSearchParams = toURLSearchParams(await searchParams);
  const defaultPageSize = await getDefaultPageSize(session.user.id);
  const filters = parseDocsFilters(urlSearchParams, defaultPageSize);

  const canEditAny = canEditAnyPost(session.user.role);
  const where: Prisma.DocWhereInput = {
    AND: [
      canEditAny ? {} : { authors: { some: { userId: session.user.id } } },
      buildFilterWhere(filters),
    ],
  };

  const [docs, totalCount] = await Promise.all([
    prismaIncludingDeleted.doc.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      // Explicit select, not `include` — deliberately excludes proseJson. It's
      // the whole document body and nothing here needs it: the Length column
      // comes from doc_length(prose_json) (below), computed in Postgres so the
      // body itself never has to cross into this process.
      select: {
        id: true,
        slug: true,
        title: true,
        visibility: true,
        createdAt: true,
        deletedByUserId: true,
        authors: {
          orderBy: { bylineOrder: "asc" },
          select: { userId: true, user: { select: { adminInitials: true } } },
        },
      },
    }),
    prismaIncludingDeleted.doc.count({ where }),
  ]);

  // A second, narrow round-trip rather than folding this into the query
  // above: Prisma has no way to project a raw SQL expression into a
  // findMany's select, and rewriting the whole permission-filtered query
  // (the canEditAny/authors-some WHERE above) as raw SQL just to add one
  // column isn't worth losing that type safety for. Now scoped to one page's
  // ids rather than every doc the user can see.
  const lengthById = new Map<string, number>();
  if (docs.length > 0) {
    const lengths = await prismaIncludingDeleted.$queryRaw<{ id: string; length: number }[]>`
      SELECT id, doc_length(prose_json) AS length FROM doc WHERE id IN (${Prisma.join(docs.map((d) => d.id))})
    `;
    for (const l of lengths) lengthById.set(l.id, l.length);
  }

  const rows = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    // "Untitled" is a render-time fallback, never stored (PLAN.md §12n) —
    // applied here so DocsTable's link shows the same string a user reads.
    // Sort and search now happen in Postgres against the stored value, so an
    // untitled doc sorts as the empty string it is, not as "Untitled".
    title: docTitleOrFallback(doc.title),
    authors: doc.authors.map((a) => a.user.adminInitials).join(", "),
    visibility: doc.visibility,
    createdAt: doc.createdAt,
    length: lengthById.get(doc.id) ?? 0,
    deleted: doc.deletedByUserId !== null,
    // Mirrors canUserEditDoc (src/lib/doc-authz.ts) without a per-row DB
    // round-trip — canEditAny already decided the WHERE clause above (an
    // AUTHOR only ever sees their own docs to begin with), so this is just
    // that same check restated per row for the Edit column.
    canEdit: canEditAny || doc.authors.some((a) => a.userId === session.user.id),
  }));

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Docs</h1>
      {/* A <div>, not <p> — <form> isn't valid inside <p> (HTML rejects a
          block-level descendant there), which React 19 also flags as a
          hydration error since the browser's own parser would silently
          close the <p> early and produce a different tree than SSR sent.
          A GET <Link> would let Next's hover-prefetch create docs nobody
          asked for (§12n) — creation is a real mutation, so it's a form
          submit, not a link to a title-collecting page. */}
      <div style={{ margin: "1em 0" }}>
        <form action={createDoc}>
          <button type="submit" className={styles.newDocButton}>
            + New doc
          </button>
        </form>
      </div>
      <DocsTable rows={rows} totalCount={totalCount} filters={filters} defaultPageSize={defaultPageSize} />
    </main>
  );
}
