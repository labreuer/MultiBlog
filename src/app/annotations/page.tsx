import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageDocs } from "@/lib/doc-authz";
import { collectMarkAttrValues, extractMarkedText } from "@/lib/tiptap-schema";
import { docTitleOrFallback } from "@/lib/doc-title";
import type { Prisma } from "@/generated/prisma/client";
import type { JSONContent } from "@tiptap/core";
import { parseAnnotationsFilters, type AnnotationsSortKey } from "@/lib/annotations-query";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import type { SortColumn } from "@/lib/table-sort";
import AnnotationsTable, { type AnnotationRow } from "@/components/AnnotationsTable";

// Deep-link-only filters (no dedicated dropdown yet, same convention as
// comments-query.ts's parseDeepLinkWhere): ?doc=<docId>, ?author=<userId>
// (a doc byline author), ?user=<userId> (who wrote the annotation).
function parseDeepLinkWhere(searchParams: URLSearchParams): Prisma.AnnotationWhereInput {
  const where: Prisma.AnnotationWhereInput = {};
  const doc = searchParams.get("doc");
  const author = searchParams.get("author");
  const user = searchParams.get("user");

  const docWhere: Prisma.DocWhereInput = {};
  if (doc) docWhere.id = doc;
  if (author) docWhere.authors = { some: { userId: author } };
  if (Object.keys(docWhere).length > 0) where.doc = docWhere;
  if (user) where.userId = user;
  return where;
}

function buildFilterWhere(filters: ReturnType<typeof parseAnnotationsFilters>): Prisma.AnnotationWhereInput {
  const where: Prisma.AnnotationWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) {
    where.OR = [
      { bodyText: { contains: filters.q, mode: "insensitive" } },
      { doc: { title: { contains: filters.q, mode: "insensitive" } } },
      { user: { name: { contains: filters.q, mode: "insensitive" } } },
      { user: { email: { contains: filters.q, mode: "insensitive" } } },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<AnnotationsSortKey>[]): Prisma.AnnotationOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.AnnotationOrderByWithRelationInput => {
    switch (key) {
      case "doc":
        return { doc: { title: dir } };
      case "author":
        return { user: { name: dir } };
      case "created":
        return { createdAt: dir };
      case "edited":
        return { editedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "status":
        // DRAFT is excluded from this whole page (baseWhere, §13d), so the
        // only values ever sorted here are LIVE and RAISED.
        return { status: dir };
      case "raisedAt":
        return { raisedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "resolvedAt":
        return { resolvedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function AnnotationsPage({
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
        <h1>Annotations</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage annotations.</p>
      </main>
    );
  }

  const urlSearchParams = toURLSearchParams(await searchParams);
  const prefs = await getTablePrefs(session.user.id, "annotations");
  const filters = parseAnnotationsFilters(urlSearchParams, prefs);

  const baseWhere: Prisma.AnnotationWhereInput = {
    AND: [
      // A DRAFT annotation (PLAN.md §13d) is a private note — invisible to
      // everyone but its own author (§13a's authz decision is explicit that
      // this holds "even from admins"), so this admin browse surface has to
      // exclude it outright rather than relying on canManageDocs to gate
      // the whole page and stop there.
      { status: { not: "DRAFT" } },
      // Scoped to the docs this viewer may *read* — canUserReadDoc's rule
      // (src/lib/doc-authz.ts) restated as a `where`, since Prisma has no way
      // to share a predicate between a per-row check and a query filter:
      // SHARED docs for anyone with canViewDocs, which the canManageDocs page
      // gate above already implies, plus this viewer's own byline-authored
      // PRIVATE ones.
      //
      // Readability rather than manage-ability is the bound that matters here
      // because of what the query below selects: doc.proseJson, rendered as
      // the Quote column, so a wider scope would put an excerpt of a PRIVATE
      // doc's body in front of someone /doc/[slug] refuses outright
      // (docs/PERMISSIONS.md). canUserAccessAnnotationYdoc
      // (src/lib/annotation-authz.ts) delegates to canUserReadDoc for the
      // same reason.
      { OR: [{ doc: { authors: { some: { userId: session.user.id } } } }, { doc: { visibility: "SHARED" } }] },
      parseDeepLinkWhere(urlSearchParams),
    ],
  };
  const where: Prisma.AnnotationWhereInput = { AND: [baseWhere, buildFilterWhere(filters)] };
  const orderBy = buildOrderBy(filters.sort);

  const [annotations, totalCount] = await Promise.all([
    prisma.annotation.findMany({
      where,
      orderBy,
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      include: {
        user: { select: { name: true, email: true } },
        doc: { select: { id: true, slug: true, title: true, proseJson: true } },
      },
    }),
    prisma.annotation.count({ where }),
  ]);

  // Quote text is derived, not stored (§12i) — resolve it once per distinct
  // doc among this page's rows, not once per row, since several rows
  // typically share a doc.
  const markedIdsByDoc = new Map<string, Set<string>>();
  const proseJsonByDoc = new Map<string, JSONContent>();
  for (const a of annotations) {
    if (proseJsonByDoc.has(a.docId) || !a.doc.proseJson) continue;
    const proseJson = a.doc.proseJson as JSONContent;
    proseJsonByDoc.set(a.docId, proseJson);
    markedIdsByDoc.set(a.docId, new Set(collectMarkAttrValues(proseJson, "annotation", "id")));
  }

  const rows: AnnotationRow[] = annotations.map((a) => {
    const isRoot = a.parentAnnotationId === null;
    const proseJson = proseJsonByDoc.get(a.docId);
    const marked = markedIdsByDoc.get(a.docId)?.has(a.id) ?? false;
    return {
      id: a.id,
      docId: a.docId,
      docSlug: a.doc.slug,
      docTitle: docTitleOrFallback(a.doc.title),
      authorName: a.user.name ?? a.user.email,
      bodyText: a.bodyText,
      quote: isRoot && marked && proseJson ? extractMarkedText(proseJson, "annotation", "id", a.id) : "",
      isRoot,
      createdAt: a.createdAt,
      editedAt: a.editedAt,
      status: a.status,
      raisedAt: a.raisedAt,
      resolvedAt: a.resolvedAt,
      deletedAt: a.deletedAt,
      deleted: a.deletedByUserId !== null,
    };
  });

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Annotations</h1>
      <AnnotationsTable
        rows={rows}
        totalCount={totalCount}
        filters={filters}
        prefs={prefs}
      />
    </main>
  );
}
