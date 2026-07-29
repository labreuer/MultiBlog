import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageDocs } from "@/lib/doc-authz";
import { canEditAnyPost } from "@/lib/authz";
import { collectMarkAttrValues, extractMarkedText } from "@/lib/tiptap-schema";
import { docTitleOrFallback } from "@/lib/doc-title";
import type { Prisma } from "@/generated/prisma/client";
import type { JSONContent } from "@tiptap/core";
import { parseAnnotationsFilters, type AnnotationsSortKey } from "@/lib/annotations-query";
import type { SortColumn } from "@/lib/use-sortable-rows";
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
      { body: { path: ["text"], string_contains: filters.q, mode: "insensitive" } },
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

  const resolvedSearchParams = await searchParams;
  const flatParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (typeof value === "string") flatParams[key] = value;
    else if (Array.isArray(value) && value.length > 0) flatParams[key] = value[0];
  }
  const urlSearchParams = new URLSearchParams(flatParams);
  const filters = parseAnnotationsFilters(urlSearchParams);

  const baseWhere: Prisma.AnnotationWhereInput = {
    AND: [
      canEditAnyPost(session.user.role) ? {} : { doc: { authors: { some: { userId: session.user.id } } } },
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
      bodyText: (a.body as { text?: string } | null)?.text ?? "",
      quote: isRoot && marked && proseJson ? extractMarkedText(proseJson, "annotation", "id", a.id) : "",
      isRoot,
      createdAt: a.createdAt,
      editedAt: a.editedAt,
      deleted: a.deletedByUserId !== null,
    };
  });

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Annotations</h1>
      <AnnotationsTable rows={rows} totalCount={totalCount} filters={filters} />
    </main>
  );
}
