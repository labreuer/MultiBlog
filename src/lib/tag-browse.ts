import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { canViewDocs, canManageDocs, canViewFiles, canManageFiles } from "@/lib/role-checks";
import { publishedPostWhere } from "@/lib/post-status";

// PLAN.md §20d — what /tag/[slug] lists, as **per-type sections**.
//
// **Deliberately not an interleaved single timeline.** That would be a UNION
// over docs, posts and files, which means re-implementing three permission
// models in one query — the easiest leak to write and the hardest to see, since
// the wrong answer looks exactly like the right one until somebody's PRIVATE
// doc shows up in a stranger's list. Three separate queries, each wearing the
// predicate that already governs its own type, cannot make that mistake: the
// doc query is `readableDocsFor`'s predicate, the post query is
// `publishedPostWhere`, the file query is `readableFilesFor`'s.
//
// Each is one indexed `tag_anchor` lookup joined to its type's table, so
// the page costs three queries regardless of how much is tagged (§20g).
//
// The counts this page shows come from these filtered queries, **never from
// `tag_metrics`** (§20d). The view counts everything live; these count what
// this viewer may see. Reading a number off the view here would be the same
// leak in a smaller font.
//
// Annotations are the fourth arc leg and get no section: PR 1 has no annotation
// chip UI (§20h), an annotation has no page of its own to link to, and listing
// them would need a container-relative deep link this page has no reason to
// invent yet.

export type TagHit = { id: string; slug: string; title: string; href: string };

export type TagBrowse = {
  docs: TagHit[];
  posts: TagHit[];
  files: TagHit[];
  /** Whether any section was capped — see PAGE_CAP. */
  capped: boolean;
};

/**
 * Per-section cap rather than per-section querystring pagination (§20j-3).
 *
 * Three independently-paginated sections on one page means three `?page=`
 * params that have to not collide, three sets of controls, and a URL nobody
 * can read — for a page that in practice has a handful of rows per type. A cap
 * with an honest "showing the first N" line reads better and is one query
 * each. If a term ever collects hundreds of anything, the kit's habits are
 * still there to reach for, and §20j-3 says to decide this when there is real
 * content to look at rather than in the abstract — this is that decision,
 * recorded, and cheap to revisit.
 */
export const PAGE_CAP = 50;

/** The shared shape of "which live assignments of this tag point at me". */
function taggedWith(tagId: string) {
  return {
    some: {
      assignment: { tagId, deletedAt: null, tag: { deletedAt: null } },
    },
  };
}

export async function browseTag(tagId: string, userId: string | null, role: Role | null): Promise<TagBrowse> {
  const [docs, posts, files] = await Promise.all([
    listDocs(tagId, userId, role),
    listPosts(tagId),
    listFiles(tagId, userId, role),
  ]);
  return {
    docs,
    posts,
    files,
    capped: docs.length === PAGE_CAP || posts.length === PAGE_CAP || files.length === PAGE_CAP,
  };
}

// canUserReadDoc as a `where` clause — the same relationship `readableDocsFor`
// has to it (src/lib/doc-authz.ts), and with the same caveat: Prisma cannot
// share a boolean predicate between a per-row check and a query filter, so
// proximity plus this comment is what keeps the two honest. Restated here
// rather than calling readableDocsFor because that one fetches *every*
// readable doc to populate a picker; this needs the same predicate ANDed with
// the tag filter, in Postgres.
async function listDocs(tagId: string, userId: string | null, role: Role | null): Promise<TagHit[]> {
  if (!userId || !role) return [];
  const or = [];
  if (canViewDocs(role)) or.push({ visibility: "SHARED" as const });
  if (canManageDocs(role)) or.push({ visibility: "PRIVATE" as const, authors: { some: { userId } } });
  if (or.length === 0) return [];

  const rows = await prisma.doc.findMany({
    where: { deletedByUserId: null, OR: or, tagAnchors: taggedWith(tagId) },
    select: { id: true, slug: true, title: true },
    orderBy: { updatedAt: "desc" },
    take: PAGE_CAP,
  });
  return rows.map((d) => ({ id: d.id, slug: d.slug, title: d.title, href: `/doc/${d.slug}` }));
}

// A published post is readable by anyone, signed in or not — so this section
// needs no viewer at all, and is the one part of this page a signed-out reader
// sees. publishedPostWhere rather than a bare publishEventId check, for the
// reason it exists: a scheduled post already carries one.
async function listPosts(tagId: string): Promise<TagHit[]> {
  const rows = await prisma.post.findMany({
    where: { ...publishedPostWhere(), tagAnchors: taggedWith(tagId) },
    select: { id: true, slug: true, title: true },
    orderBy: { publishedAt: "desc" },
    take: PAGE_CAP,
  });
  return rows.map((p) => ({ id: p.id, slug: p.slug, title: p.title, href: `/${p.slug}` }));
}

// canUserReadFile as a `where` clause — `readableFilesFor`'s predicate, ANDed
// with the tag filter for the same reason listDocs restates its own.
async function listFiles(tagId: string, userId: string | null, role: Role | null): Promise<TagHit[]> {
  if (!userId || !role) return [];
  const or = [];
  if (canViewFiles(role)) or.push({ visibility: "SHARED" as const });
  if (canManageFiles(role)) or.push({ visibility: "PRIVATE" as const, owners: { some: { userId } } });
  if (or.length === 0) return [];

  const rows = await prisma.storedFile.findMany({
    where: { deletedByUserId: null, OR: or, tagAnchors: taggedWith(tagId) },
    select: { id: true, slug: true, title: true },
    orderBy: { createdAt: "desc" },
    take: PAGE_CAP,
  });
  return rows.map((f) => ({ id: f.id, slug: f.slug, title: f.title, href: `/pdf/${f.slug}` }));
}
