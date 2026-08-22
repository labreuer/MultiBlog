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
      // The file counterpart, so searching a PDF's title finds its annotations
      // exactly as searching a doc's does.
      { file: { title: { contains: filters.q, mode: "insensitive" } } },
      { user: { name: { contains: filters.q, mode: "insensitive" } } },
      { user: { email: { contains: filters.q, mode: "insensitive" } } },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<AnnotationsSortKey>[]): Prisma.AnnotationOrderByWithRelationInput[] {
  return sort.flatMap(({ key, dir }): Prisma.AnnotationOrderByWithRelationInput[] => {
    // PLAN.md §19 — `doc` is the one key that expands to two terms. The column
    // shows a doc *or* a file title, and Prisma can't order by "whichever of
    // two relations is present". Ordering by each in turn groups rows by
    // container kind and sorts alphabetically within each group: stable and
    // honest, if not a true merge. A merged ordering would need a view over
    // both titles, which is more machinery than one sort key deserves.
    if (key === "doc") {
      // Plain `dir`, not the {sort, nulls} form: `title` is NOT NULL on both
      // models, so Prisma rejects nulls handling for it. The *relation* is what
      // is nullable, and Prisma orders a missing to-one relation last on its
      // own — which is exactly the grouping this wants.
      return [{ doc: { title: dir } }, { file: { title: dir } }];
    }
    return [orderTermFor(key, dir)];
  });
}

function orderTermFor(
  key: Exclude<AnnotationsSortKey, "doc">,
  dir: "asc" | "desc",
): Prisma.AnnotationOrderByWithRelationInput {
  switch (key) {
    case "author":
      return { user: { name: dir } };
    case "created":
      return { createdAt: dir };
    case "edited":
      return { editedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    case "status":
      // DRAFT is excluded from this whole page (baseWhere, §13d), so the only
      // values ever sorted here are LIVE and RAISED.
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
      // Scoped to what this viewer may *read* — canUserReadDoc's and
      // canUserReadFile's rules restated as a `where`, since Prisma has no way
      // to share a predicate between a per-row check and a query filter:
      // SHARED containers for anyone who passes the page gate above, plus this
      // viewer's own byline-authored PRIVATE ones.
      //
      // Readability rather than manage-ability is the bound that matters here
      // because of what the query below selects: doc.proseJson, rendered as
      // the Quote column, so a wider scope would put an excerpt of a PRIVATE
      // doc's body in front of someone /doc/[slug] refuses outright
      // (docs/PERMISSIONS.md). canUserAccessAnnotationYdoc
      // (src/lib/annotation-authz.ts) asks the same pair of questions.
      //
      // PLAN.md §19 — **both containers**, each scoped by its own read rule.
      // A relation filter never matches a null foreign key, so the doc terms
      // exclude every file annotation and vice versa; the four together are
      // exactly "annotations on something this viewer may read".
      //
      // That /annotations sees PDF annotations at all is one of the reasons
      // they are Postgres rows rather than entries in a per-file ydoc — a
      // listing that silently covered half of them would give that reason away.
      {
        OR: [
          { doc: { authors: { some: { userId: session.user.id } } } },
          { doc: { visibility: "SHARED" } },
          { file: { owners: { some: { userId: session.user.id } } } },
          { file: { visibility: "SHARED" } },
        ],
      },
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
        // A file has no proseJson to excerpt: a PDF annotation's quote is
        // always the stored column (derived server-side at post time), so
        // there is no mark to hunt for and no document body to read.
        file: { select: { id: true, slug: true, title: true } },
      },
    }),
    prisma.annotation.count({ where }),
  ]);

  // Quote text is derived for a *mark*-anchored annotation (§12i) — resolve
  // it once per distinct doc among this page's rows, not once per row, since
  // several rows typically share a doc. A column-anchored one (§13o) and an
  // anchored reply (§13p) carry theirs on the row and skip all of this.
  const markedIdsByDoc = new Map<string, Set<string>>();
  const proseJsonByDoc = new Map<string, JSONContent>();

  // Both containers, flattened to one shape. `containerKind` is what the table
  // links through; everything else about a row reads the same either way, which
  // is the payoff for annotations being one table rather than two.
  //
  // The `where` above guarantees exactly one relation is present. Asserted
  // loudly rather than defaulted, so a disagreement between that clause and
  // this names itself instead of surfacing as an empty cell.
  const rowsWithContainer = annotations.map((a) => {
    const container = a.doc
      ? ({ kind: "doc", id: a.doc.id, slug: a.doc.slug, title: docTitleOrFallback(a.doc.title) } as const)
      : a.file
        ? ({ kind: "file", id: a.file.id, slug: a.file.slug, title: a.file.title } as const)
        : null;
    if (!container) {
      throw new Error(`/annotations selected annotation ${a.id} with no container — its where clause should prevent this.`);
    }
    return { ...a, container };
  });

  // The mark-derived quote is a doc-only concern (§12i): a file has no ydoc to
  // hold a mark, so its rows skip this entirely.
  const docAnnotations = rowsWithContainer.filter(
    (a): a is (typeof rowsWithContainer)[number] & { doc: NonNullable<(typeof a)["doc"]> } => a.doc !== null,
  );

  for (const a of docAnnotations) {
    if (proseJsonByDoc.has(a.doc.id) || !a.doc.proseJson) continue;
    const proseJson = a.doc.proseJson as JSONContent;
    proseJsonByDoc.set(a.doc.id, proseJson);
    markedIdsByDoc.set(a.doc.id, new Set(collectMarkAttrValues(proseJson, "annotation", "id")));
  }

  const rows: AnnotationRow[] = rowsWithContainer.map((a) => {
    const isRoot = a.parentAnnotationId === null;
    const proseJson = a.doc ? proseJsonByDoc.get(a.doc.id) : undefined;
    const marked = a.doc ? (markedIdsByDoc.get(a.doc.id)?.has(a.id) ?? false) : false;
    return {
      id: a.id,
      containerKind: a.container.kind,
      docId: a.container.id,
      docSlug: a.container.slug,
      docTitle: a.container.title,
      authorName: a.user.name ?? a.user.email,
      bodyText: a.bodyText,
      // Stored first, since a row that has one was never marked and looking
      // for its mark would always come up empty. A reply can have one now
      // too (PLAN.md §13p) — quoting a passage of the annotation it answers
      // rather than of the doc — which is why the `isRoot` gate applies only
      // to the mark branch, where it is still exactly right.
      quote: a.quotedText || (isRoot && marked && proseJson ? extractMarkedText(proseJson, "annotation", "id", a.id) : ""),
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
