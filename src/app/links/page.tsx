import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { canManageDocs, canManageFiles, canViewDocs, canViewFiles } from "@/lib/role-checks";
import { canUserDeleteAnchoredLink } from "@/lib/anchored-link-authz";
import { targetFromColumns, targetKey, type AnchorTarget } from "@/lib/anchors";
import { docTitleOrFallback } from "@/lib/doc-title";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parseLinksFilters, type LinksFilters, type LinksSortKey } from "@/lib/links-query";
import type { SortColumn } from "@/lib/table-sort";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import LinksTable, { type LinkRow, type LinkRowTarget } from "@/components/LinksTable";

export const metadata: Metadata = { title: "Links" };

// docs/ANCHORED_LINKS.md, "The management table" — every anchored link this
// viewer may know of, through the §16 admin-table kit.
//
// **The page gate is canManageDocs**, the bar every other admin listing sets
// (/tags' reasoning: an admin table is an editorial surface, and a seventh
// visibility tier for this one would be a UI regression before it was a
// security improvement). AUTHORIZED users create and follow links without
// ever needing this table.
//
// **Row scoping is the follow path's rule, restated as a `where`.** A link is
// listed when this viewer created it (drafts included — only their own; a
// draft is its creator's alone, docs/PERMISSIONS.md) or when it is minted and
// *some* anchor of it points into a doc or file this viewer may read. That
// is the landing route's "exists for this viewer" narrowed by "and has
// something to show them" — the one row the landing route would render as
// its empty page is the one this table leaves out, because a listing of ids
// that resolve to nothing is noise for the viewer and a hand-out of ids for
// everyone else.
//
// Readability is the bound, not manage-ability, for the reason /annotations
// gives: the cells show `quoted_text`, an excerpt of the target's body, and a
// wider scope would put an excerpt of a PRIVATE doc in front of someone
// /doc/[slug] refuses outright. The same clause bounds the free-text search,
// or ?q= would be a probe into passages the viewer cannot see. Within a
// listed row the cells then apply the filter *per target*, so a link that
// spans a readable PDF and an unreadable doc lists — and shows the PDF's
// passages only, with nothing acknowledging the doc's.
//
// No ADMIN "Show all" override, again as /annotations: an override widens
// which rows are listed, and here that would widen which excerpts are shown.

/**
 * canUserReadDoc as a `where` on Doc, for this viewer — readableDocsWhere's
 * rule (src/lib/doc-authz.ts) restated here with the same caveat it carries:
 * Prisma has no way to share a predicate between a per-row check and a
 * filter, so proximity to that file plus this comment is what keeps the two
 * honest. Null when the viewer may read no doc at all.
 */
function readableDocWhere(userId: string, role: Role): Prisma.DocWhereInput | null {
  const or: Prisma.DocWhereInput[] = [];
  if (canViewDocs(role)) or.push({ visibility: "SHARED" });
  if (canManageDocs(role)) or.push({ visibility: "PRIVATE", authors: { some: { userId } } });
  if (or.length === 0) return null;
  // Relation filters bypass prisma.ts's soft-delete $extends, so the deleted
  // check is spelled out — a link whose only target is a deleted doc has
  // nothing to show and should not list on that doc's account.
  return { deletedByUserId: null, OR: or };
}

/** canUserReadFile as a `where` on StoredFile — readableFilesFor's rule (src/lib/file-authz.ts). */
function readableFileWhere(userId: string, role: Role): Prisma.StoredFileWhereInput | null {
  const or: Prisma.StoredFileWhereInput[] = [];
  if (canViewFiles(role)) or.push({ visibility: "SHARED" });
  if (canManageFiles(role)) or.push({ visibility: "PRIVATE", owners: { some: { userId } } });
  if (or.length === 0) return null;
  return { deletedByUserId: null, OR: or };
}

/**
 * "An anchor whose target this viewer may read" — the two clauses above
 * lifted onto anchored_link_anchor. Post and annotation targets have no
 * arm here because the v1 writer never produces them; if it ever does, the
 * follow path (`anchoredLinkForViewer`) needs the same arm at the same time.
 */
function readableAnchorWhere(
  docWhere: Prisma.DocWhereInput | null,
  fileWhere: Prisma.StoredFileWhereInput | null,
): Prisma.AnchoredLinkAnchorWhereInput {
  const or: Prisma.AnchoredLinkAnchorWhereInput[] = [];
  if (docWhere) or.push({ doc: docWhere });
  if (fileWhere) or.push({ file: fileWhere });
  // Unreachable behind the canManageDocs gate (which implies canViewDocs),
  // but an empty OR would match everything in some Prisma versions and
  // nothing in others — so say "nothing" explicitly.
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}

// Deep-link-only filters (no dedicated control, the /annotations convention):
// ?user=<userId> (who created the link), ?doc=<docId> / ?file=<fileId> (links
// with a passage in that object). All three narrow within the viewer's scope;
// none widens it.
function parseDeepLinkWhere(searchParams: URLSearchParams): Prisma.AnchoredLinkWhereInput {
  const clauses: Prisma.AnchoredLinkWhereInput[] = [];
  const user = searchParams.get("user");
  const doc = searchParams.get("doc");
  const file = searchParams.get("file");
  if (user) clauses.push({ createdById: user });
  // Two separate `some`s, not one: ?doc=&file= together means "a passage in
  // that doc *and* a passage in that PDF", which no single anchor row can be.
  if (doc) clauses.push({ anchors: { some: { docId: doc } } });
  if (file) clauses.push({ anchors: { some: { fileId: file } } });
  return clauses.length > 0 ? { AND: clauses } : {};
}

function buildFilterWhere(
  filters: LinksFilters,
  readableAnchor: Prisma.AnchoredLinkAnchorWhereInput,
): Prisma.AnchoredLinkWhereInput {
  const where: Prisma.AnchoredLinkWhereInput = {};
  // AnchoredLink sits outside prisma.ts's soft-delete $extends (read through
  // anchor includes elsewhere, which the extension cannot reach), so the
  // plain client already sees deleted rows and this is the whole toggle.
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) {
    const contains = { contains: filters.q, mode: "insensitive" as const };
    where.OR = [
      { createdBy: { name: contains } },
      { createdBy: { email: contains } },
      // Quotes and titles are searched only on anchors whose target the
      // viewer may read — see the file comment. `some` over AND: the same
      // anchor row has to be both readable and matching.
      {
        anchors: {
          some: {
            AND: [readableAnchor, { OR: [{ quotedText: contains }, { doc: { title: contains } }, { file: { title: contains } }] }],
          },
        },
      },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<LinksSortKey>[]): Prisma.AnchoredLinkOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.AnchoredLinkOrderByWithRelationInput => {
    switch (key) {
      case "createdBy":
        return { createdBy: { name: { sort: dir, nulls: "last" } } };
      case "created":
        return { createdAt: dir };
      case "minted":
        // A draft is a null mintedAt; the same nulls rule the soft-delete
        // pair uses, so ascending leads with the (at most one) draft and
        // descending ends with it.
        return { mintedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "id":
        return { id: dir };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function LinksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Hoisted above the gate so an anonymous visitor's callbackUrl keeps the
  // filters, sort and page they arrived with — this table's whole state lives
  // in the querystring (CLAUDE.md, "Admin tables are one kit").
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery("/links", urlSearchParams)));
  }
  if (!canManageDocs(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Links</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to browse the link table.</p>
      </main>
    );
  }
  const viewer = { id: session.user.id, role: session.user.role };

  const prefs = await getTablePrefs(viewer.id, "links");
  const filters = parseLinksFilters(urlSearchParams, prefs);

  const docWhere = readableDocWhere(viewer.id, viewer.role);
  const fileWhere = readableFileWhere(viewer.id, viewer.role);
  const readableAnchor = readableAnchorWhere(docWhere, fileWhere);

  const viewerScope: Prisma.AnchoredLinkWhereInput = {
    OR: [
      // Own links, drafts included. Nobody else's draft, whatever the role.
      { createdById: viewer.id },
      { mintedAt: { not: null }, anchors: { some: readableAnchor } },
    ],
  };
  const where: Prisma.AnchoredLinkWhereInput = {
    AND: [viewerScope, parseDeepLinkWhere(urlSearchParams), buildFilterWhere(filters, readableAnchor)],
  };

  const [links, totalCount] = await Promise.all([
    prisma.anchoredLink.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      select: {
        id: true,
        createdById: true,
        createdAt: true,
        mintedAt: true,
        deletedAt: true,
        deletedByUserId: true,
        createdBy: { select: { name: true, email: true } },
        anchors: {
          // [partOrder, id] — removals leave gaps and nothing renumbers,
          // the order every reader of this table uses.
          orderBy: [{ partOrder: "asc" }, { id: "asc" }],
          select: { docId: true, postId: true, fileId: true, targetAnnotationId: true, quotedText: true },
        },
      },
    }),
    prisma.anchoredLink.count({ where }),
  ]);

  // The per-target filter, once per page rather than once per row: two
  // queries wearing the read clauses, over the distinct targets this page's
  // anchors name. A target that comes back is readable and live (prisma.doc
  // and prisma.storedFile ride the soft-delete $extends as well); one that
  // doesn't is omitted from its row's cells with no trace, the follow path's
  // rule. This is `anchoredLinkForViewer`'s per-group gate as a set
  // operation — that function asks canUserReadDoc per group, which on a page
  // of 25 links would be a query apiece.
  const docIds = [...new Set(links.flatMap((link) => link.anchors.map((a) => a.docId)).filter((id) => id !== null))];
  const fileIds = [...new Set(links.flatMap((link) => link.anchors.map((a) => a.fileId)).filter((id) => id !== null))];
  const [docs, files] = await Promise.all([
    docIds.length > 0 && docWhere
      ? prisma.doc.findMany({ where: { ...docWhere, id: { in: docIds } }, select: { id: true, title: true } })
      : [],
    fileIds.length > 0 && fileWhere
      ? prisma.storedFile.findMany({
          where: { ...fileWhere, id: { in: fileIds } },
          select: { id: true, title: true, slug: true },
        })
      : [],
  ]);
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const filesById = new Map(files.map((file) => [file.id, file]));

  const rows: LinkRow[] = links.map((link) => {
    // Group parts by target in first-appearance order, as the landing page
    // does; hrefs carry ?sel= — doc by id (rename-proof), file by slug.
    const sel = `?sel=${encodeURIComponent(link.id)}`;
    const groups = new Map<string, { target: AnchorTarget; quotes: string[] }>();
    for (const anchor of link.anchors) {
      const target = targetFromColumns(anchor);
      if (!target) continue;
      const key = targetKey(target);
      const group = groups.get(key) ?? { target, quotes: [] };
      group.quotes.push(anchor.quotedText);
      groups.set(key, group);
    }
    const targets: LinkRowTarget[] = [];
    for (const { target, quotes } of groups.values()) {
      if (target.kind === "doc") {
        const doc = docsById.get(target.id);
        if (doc) targets.push({ kind: "doc", title: docTitleOrFallback(doc.title), href: `/doc/${doc.id}${sel}`, quotes });
      } else if (target.kind === "file") {
        const file = filesById.get(target.id);
        if (file) targets.push({ kind: "file", title: file.title, href: `/pdf/${file.slug}${sel}`, quotes });
      }
      // post / annotation: the v1 writer never produces these; omitted, as
      // anchoredLinkForViewer omits them.
    }
    return {
      id: link.id,
      createdByName: link.createdBy.name ?? link.createdBy.email,
      createdAt: link.createdAt,
      mintedAt: link.mintedAt,
      targets,
      deletedAt: link.deletedAt,
      deleted: link.deletedByUserId !== null,
      // Decided here from columns already selected rather than per row
      // through a query — the /files shape. Never true for a draft.
      canManage: canUserDeleteAnchoredLink(viewer.id, viewer.role, link),
    };
  });

  return (
    <main style={{ maxWidth: 1100, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Links</h1>
      <LinksTable rows={rows} totalCount={totalCount} filters={filters} prefs={prefs} />
    </main>
  );
}
