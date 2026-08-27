import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canManageDocs, canEditAnySharedDoc } from "@/lib/doc-authz";
import { isAdmin } from "@/lib/authz";
import { createDoc } from "@/app/actions/docs";
import { docTitleOrFallback } from "@/lib/doc-title";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parseDocsFilters, type DocsFilters, type DocsSortKey } from "@/lib/docs-query";
import { authorFilterWhere, listAuthorFilterOptions } from "@/lib/author-filter";
import type { SortColumn } from "@/lib/table-sort";
import DocsTable from "@/components/DocsTable";
import DocImportButton from "@/components/DocImportButton";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Docs" };

function buildFilterWhere(filters: DocsFilters): Prisma.DocWhereInput {
  const where: Prisma.DocWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) where.title = { contains: filters.q, mode: "insensitive" };
  // The Authors filter narrows this listing; it never widens it (see
  // authorFilterWhere's header comment for the four modes' semantics, and
  // this file's authorScope for why NONE in particular can't be used to
  // escape PRIVATE-doc scoping).
  Object.assign(where, authorFilterWhere(filters.authors, filters.authorMode) as Prisma.DocWhereInput);
  return where;
}

function buildOrderBy(sort: SortColumn<DocsSortKey>[]): Prisma.DocOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.DocOrderByWithRelationInput => {
    switch (key) {
      case "title":
        return { title: dir };
      case "authors":
        // Through the doc_metrics view — the same string_agg the cell shows.
        // NULL for a doc with no authors, kept last either way.
        return { metrics: { byline: { sort: dir, nulls: "last" } } };
      case "visibility":
        return { visibility: dir };
      case "created":
        return { createdAt: dir };
      case "length":
        // A plain column on doc, kept current by the doc_sync_prose_json_length
        // trigger — so this is an ordinary column sort with no view, no join
        // and no per-row recomputation of doc_length. NOT NULL (a doc with no
        // body yet measures 0), so no nulls handling, unlike byline above.
        return { proseJsonLength: dir };
      case "annotations":
        // Back through doc_metrics, like authors above — a *filtered* count
        // (live, non-DRAFT), which Prisma's `_count` can't express. No `nulls`
        // handling, unlike byline beside it: the view COALESCEs the count to 0
        // so the column is declared non-null and Prisma rejects the
        // {sort, nulls} form for it. A doc with no view row at all — no
        // authors *and* no annotations — still sorts as a NULL *relation*,
        // which Prisma puts last. Same arrangement as /files' annotations key.
        return { metrics: { annotationCount: dir } };
      case "slug":
        return { slug: dir };
      case "updatedAt":
        return { updatedAt: dir };
      case "updatedBy":
        return { updatedBy: { name: { sort: dir, nulls: "last" } } };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
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
  // Run concurrently — the option list is independent of prefs/filters, so
  // fetching it costs no extra latency in series.
  const [prefs, authorOptions] = await Promise.all([
    getTablePrefs(session.user.id, "docs"),
    listAuthorFilterOptions(session.user.id),
  ]);
  const filters = parseDocsFilters(
    urlSearchParams,
    prefs,
    authorOptions.map((o) => o.slug),
  );

  // Which rows this table selects (docs/PERMISSIONS.md). It is its own query rather
  // than a call into doc-authz.ts, so it has to restate that module's rule
  // itself and stay in step with it:
  //   - a SHARED doc is listed for any ADMIN/EDITOR, byline or not, matching
  //     the doc canUserEditDoc lets them open and edit straight from a URL —
  //     which is what keeps the table from hiding a doc its viewer can edit;
  //   - a PRIVATE doc is listed for its byline authors;
  //   - ADMIN alone can drop that scoping for this listing with the "Show all
  //     docs" checkbox (?showAllDocs=1), an explicit per-visit opt-in stored
  //     nowhere. It widens this query and only this query: a PRIVATE doc the
  //     admin doesn't author still goes through canUserReadDoc/canUserEditDoc
  //     on its own routes, which refuse it.
  const viewerIsAdmin = isAdmin(session.user.role);
  const viewerCanEditAnyShared = canEditAnySharedDoc(session.user.role);
  const bypassAuthorScoping = viewerIsAdmin && filters.showAllDocs;
  const authorScope: Prisma.DocWhereInput = {
    OR: [
      { authors: { some: { userId: session.user.id } } },
      ...(viewerCanEditAnyShared ? [{ visibility: "SHARED" as const }] : []),
    ],
  };
  const where: Prisma.DocWhereInput = {
    AND: [bypassAuthorScoping ? {} : authorScope, buildFilterWhere(filters)],
  };

  const [docs, totalCount] = await Promise.all([
    prismaIncludingDeleted.doc.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      // Explicit select, not `include` — deliberately excludes proseJson. It's
      // the whole document body and nothing here needs it: proseJsonLength is
      // the measurement of it, kept current in Postgres by a trigger, so the
      // body itself never has to cross into this process.
      select: {
        id: true,
        slug: true,
        title: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
        deletedByUserId: true,
        deletedAt: true,
        proseJsonLength: true,
        // Both view columns are read from the same view that sorts them, so
        // the displayed and sorted expressions can't drift (§16e).
        metrics: { select: { byline: true, annotationCount: true } },
        // Still needed, but only for the ids: canEdit below is a membership
        // test, not a display value. The User join this used to carry (for
        // adminInitials) is the view's job now.
        authors: { select: { userId: true } },
        // A raw updated_by_user_id would be a bare cuid on screen; resolved to
        // the same name-or-email fallback /comments' Changed by and
        // /annotations' Author already use.
        updatedBy: { select: { name: true, email: true } },
      },
    }),
    prismaIncludingDeleted.doc.count({ where }),
  ]);

  const rows = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    // "Untitled" is a render-time fallback, never stored (PLAN.md §12n) —
    // applied here so DocsTable's link shows the same string a user reads.
    // Sort and search now happen in Postgres against the stored value, so an
    // untitled doc sorts as the empty string it is, not as "Untitled".
    title: docTitleOrFallback(doc.title),
    // NULL only when the doc has no authors — the same empty cell the JS join
    // produced for that case.
    authors: doc.metrics?.byline ?? "",
    // 0 when the doc has no view row at all (no authors and no annotations);
    // the view itself already COALESCEs the count for every doc that does.
    annotationCount: doc.metrics?.annotationCount ?? 0,
    visibility: doc.visibility,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    updatedByName: doc.updatedBy ? (doc.updatedBy.name ?? doc.updatedBy.email) : "",
    length: doc.proseJsonLength,
    deletedAt: doc.deletedAt,
    deleted: doc.deletedByUserId !== null,
    // Whether the Edit column renders a link, decided here rather than per
    // row through canUserEditDoc (src/lib/doc-authz.ts), which costs a query
    // apiece — these two terms are that function's rule. The "Show all docs"
    // override has no say: it widens which rows are listed, not who may edit
    // them, so a PRIVATE doc it brings into view carries no Edit link and the
    // column agrees with what /doc/[slug]/edit would answer.
    canEdit:
      doc.authors.some((a) => a.userId === session.user.id) ||
      (viewerCanEditAnyShared && doc.visibility === "SHARED"),
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
      {/* space-between rather than a margin on either child, and flex-start so
          the import block's paste panel and errors grow downward instead of
          re-centering "+ New doc" against it — docs/DOC_IMPORT.md §9. */}
      <div
        style={{
          margin: "1em 0",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1.5em",
        }}
      >
        <form action={createDoc}>
          <button type="submit" className={styles.newDocButton}>
            + New doc
          </button>
        </form>
        {/* Same permission as "+ New doc" — this block is already inside the
            canManageDocs gate above (§12f); importMarkdownDocAction re-checks
            it server-side regardless. */}
        <DocImportButton className={styles.newDocButton} />
      </div>
      <DocsTable
        rows={rows}
        totalCount={totalCount}
        filters={filters}
        prefs={prefs}
        isAdmin={viewerIsAdmin}
        authorOptions={authorOptions}
      />
    </main>
  );
}
