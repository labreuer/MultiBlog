import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canManageDocs, canEditAnySharedDoc, canEditDocRow } from "@/lib/doc-authz";
import { allowedVisibilities, isSharedOrPublic, sharedOrPublic } from "@/lib/doc-visibility";
import { isAdmin } from "@/lib/authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { toURLSearchParams, withoutSortKey } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import {
  DEFAULT_SORT,
  parseShowAll,
  parseWikiPagesFilters,
  type WikiPagesFilters,
  type WikiPagesSortKey,
} from "@/lib/wiki-pages-query";
import type { SortColumn } from "@/lib/table-sort";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import { docPagePath, wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import { parseTagList } from "@/lib/tag-data";
import { codeDefaultColumns } from "@/lib/admin-table-columns";
import { staffDisplayNameOf } from "@/lib/display-name";
import { wikiAddressHistoriesOf } from "@/lib/wiki-rename";
import WikiPagesTable, { type WikiPageRow } from "@/components/WikiPagesTable";

// docs/WIKI.md "Listing wiki pages" — every wiki page this viewer's /docs
// scope would list, in an admin table of its own; /docs lists no wiki page.
// A static segment, which Next matches ahead of /wiki/[owner]/[page].

export const metadata: Metadata = { title: "Wiki pages" };

const PATH = "/wiki/special/pages";

function buildFilterWhere(filters: WikiPagesFilters): Prisma.DocWhereInput {
  const where: Prisma.DocWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) where.wikiName = { contains: filters.q, mode: "insensitive" };
  if (filters.namespace?.kind === "commons") where.wikiOwnerUserId = null;
  if (filters.namespace?.kind === "person") where.wikiOwner = { slug: filters.namespace.slug };
  if (filters.visibility) where.visibility = filters.visibility;
  return where;
}

function buildOrderBy(sort: SortColumn<WikiPagesSortKey>[]): Prisma.DocOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.DocOrderByWithRelationInput => {
    switch (key) {
      case "namespace":
        // The commons, with no owner, sorts where Postgres puts a NULL
        // (wiki-pages-query.ts says why it isn't first ascending).
        return { wikiOwner: { slug: dir } };
      case "name":
        // The folded key, so case doesn't order it. Never null on a wiki
        // page, which is every row here.
        return { wikiNameKey: { sort: dir, nulls: "last" } };
      case "variant":
        return { wikiVariant: dir };
      case "visibility":
        return { visibility: dir };
      case "authors":
        return { metrics: { byline: { sort: dir, nulls: "last" } } };
      case "updatedAt":
        return { updatedAt: dir };
      case "length":
        return { proseJsonLength: dir };
      case "tags":
        return { tagSummary: { names: { sort: dir, nulls: "last" } } };
      case "forkedFrom":
        // By the parent's id, never its title (wiki-pages-query.ts).
        return { forkedFromDocId: { sort: dir, nulls: "last" } };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function WikiPagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read before the gate, so a signed-out visitor's callbackUrl keeps the
  // table's state, all of which is in the querystring.
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery(PATH, urlSearchParams)));
  }
  // /docs' gate, since its rows are /docs' scope.
  if (!canManageDocs(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Wiki pages</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage docs.</p>
      </main>
    );
  }
  const viewerId = session.user.id;
  const role = session.user.role;

  // /docs' scope (src/app/docs/page.tsx says why it restates doc-authz.ts'
  // rule): the viewer's bylines, and every SHARED or PUBLIC page for an ADMIN
  // or EDITOR. An ADMIN's "Show all" drops it for this listing alone; the
  // page's own routes still refuse a PRIVATE page the ADMIN isn't on.
  const viewerIsAdmin = isAdmin(role);
  const bypassAuthorScoping = viewerIsAdmin && parseShowAll(urlSearchParams);
  const authorScope: Prisma.DocWhereInput = {
    OR: [
      { authors: { some: { userId: viewerId } } },
      ...(canEditAnySharedDoc(role) ? [{ visibility: sharedOrPublic() }] : []),
    ],
  };
  const scope: Prisma.DocWhereInput = {
    AND: [{ wikiName: { not: null } }, bypassAuthorScoping ? {} : authorScope],
  };

  // The namespace filter offers the owners with a page in this listing, and
  // honours no other slug, so it names no one whose pages the viewer can't
  // see listed. Deleted owners included: their pages outlive them.
  const [prefs, owners] = await Promise.all([
    getTablePrefs(viewerId, "wiki"),
    prismaIncludingDeleted.user.findMany({
      where: { wikiPages: { some: scope } },
      select: { slug: true },
      orderBy: { slug: "asc" },
    }),
  ]);
  const ownerSlugs = owners.map((o) => o.slug);
  const filters = parseWikiPagesFilters(urlSearchParams, prefs, ownerSlugs);
  filters.showAll = bypassAuthorScoping;

  const where: Prisma.DocWhereInput = { AND: [scope, buildFilterWhere(filters)] };
  // As on /docs: under the override, the Tags cells of rows the viewer can't
  // read are withheld, so ordering by tags would hint at them.
  if (bypassAuthorScoping) filters.sort = withoutSortKey(filters.sort, "tags", DEFAULT_SORT);
  const showTags = (filters.cols ?? codeDefaultColumns("wiki")).includes("tags");

  const [docs, totalCount] = await Promise.all([
    prismaIncludingDeleted.doc.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      // No proseJson: Length is the stored measurement of it.
      select: {
        id: true,
        visibility: true,
        wikiName: true,
        wikiVariant: true,
        wikiOwnerUserId: true,
        wikiOwner: { select: { slug: true } },
        updatedAt: true,
        deletedByUserId: true,
        deletedAt: true,
        proseJsonLength: true,
        metrics: { select: { byline: true } },
        tagSummary: showTags && { select: { terms: true } },
        // Membership only: whether the viewer is on the byline.
        authors: { where: { userId: viewerId }, select: { userId: true } },
        // What the Forked from cell needs to name the parent, or not
        // (docs/FORKS.md "Only what the viewer can read is named").
        forkedFrom: {
          select: {
            id: true,
            slug: true,
            title: true,
            visibility: true,
            deletedByUserId: true,
            wikiName: true,
            wikiVariant: true,
            wikiOwner: { select: { slug: true } },
            authors: { where: { userId: viewerId }, select: { userId: true } },
          },
        },
      },
    }),
    prismaIncludingDeleted.doc.count({ where }),
  ]);

  // docs/WIKI.md "Deleting a page": a delete lists the past addresses it
  // takes with the page, so each live row whose Delete is offered carries
  // them. A deleted page has none: they went with it.
  const histories = await wikiAddressHistoriesOf(
    docs.filter((doc) => doc.deletedByUserId === null).map((doc) => doc.id),
    (u) => staffDisplayNameOf(u, role),
  );

  const rows: WikiPageRow[] = docs.map((doc) => {
    const isAuthor = doc.authors.length > 0;
    // canUserReadDoc's rule over the row in hand, as /docs inlines it: only a
    // row the "Show all" override lists can fail it.
    const readable = isSharedOrPublic(doc.visibility) || isAuthor;
    const personal = doc.wikiOwnerUserId !== null;
    const owner: WikiOwner = doc.wikiOwner ? { kind: "person", slug: doc.wikiOwner.slug } : { kind: "commons" };
    const name = doc.wikiName!;
    const path = wikiPagePath({ owner, name, variant: doc.wikiVariant });
    const deleted = doc.deletedByUserId !== null;
    // docs/WIKI.md "Permissions": canEditDocRow, which refuses the SHARED
    // bypass on a person's page, decides Edit. The Visibility cell adds an
    // ADMIN's lowering of a person's page they can't edit, to the values
    // allowedVisibilities offers a non-owner. Deleting and restoring a
    // person's page is its owner's alone; a commons page's, its editors'.
    // setDocVisibility and setDocDeleted ask all of it again under the row
    // lock: these only decide what is offered.
    const canEdit = canEditDocRow({ visibility: doc.visibility, wikiOwnerUserId: doc.wikiOwnerUserId, isAuthor }, role);
    const canSetVisibility = canEdit || (personal && viewerIsAdmin);
    const canDelete = personal ? doc.wikiOwnerUserId === viewerId && canEdit : canEdit;
    const parent = doc.forkedFrom;
    const parentReadable =
      parent !== null &&
      parent.deletedByUserId === null &&
      (isSharedOrPublic(parent.visibility) || parent.authors.length > 0);
    return {
      id: doc.id,
      namespace: owner,
      name,
      variant: doc.wikiVariant,
      // A deleted page's address answers nothing, so its name isn't linked
      // and it is edited at /doc/<id>/edit (docs/WIKI.md "Deleting a page").
      path: deleted ? null : path,
      editPath: deleted ? `/doc/${doc.id}/edit` : `${path}/edit`,
      authors: doc.metrics?.byline ?? "",
      visibility: doc.visibility,
      visibilities: allowedVisibilities(doc, viewerId),
      updatedAt: doc.updatedAt,
      length: doc.proseJsonLength,
      // Null, withheld, on a row only the override lists, as on /docs.
      tags: readable ? parseTagList(doc.tagSummary?.terms) : null,
      forkedFrom:
        parent === null
          ? null
          : parentReadable
            ? { kind: "named", title: docTitleOrFallback(parent.title), path: docPagePath(parent) }
            : { kind: "hidden" },
      deletedAt: doc.deletedAt,
      deleted,
      canEdit,
      canSetVisibility,
      canDelete,
      canTag: readable,
      addressHistory: canDelete ? (histories.get(doc.id) ?? []) : [],
    };
  });

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Wiki pages</h1>
      <WikiPagesTable
        rows={rows}
        totalCount={totalCount}
        filters={filters}
        prefs={prefs}
        isAdmin={viewerIsAdmin}
        ownerSlugs={ownerSlugs}
      />
    </main>
  );
}
