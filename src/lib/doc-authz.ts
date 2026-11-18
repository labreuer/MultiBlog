import type { DocVisibility, Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canManageDocs, canViewDocs } from "@/lib/role-checks";
import { isSharedOrPublic, sharedOrPublic } from "@/lib/doc-visibility";
import { wikiAddressOfDoc, wikiLabel } from "@/lib/wiki-address";

export { canManageDocs, canViewDocs } from "@/lib/role-checks";

// Per-doc access, on two axes (docs/PERMISSIONS.md):
//
//   SHARED   read by anyone with canViewDocs; edit by ADMIN/EDITOR whatever
//            the byline says, or by any listed author.
//   PRIVATE  read and edit by its listed DocAuthors alone — every role,
//            ADMIN and EDITOR included.
//
// PUBLIC, a wiki page's, is SHARED here: every rule below asks
// isSharedOrPublic or sharedOrPublic() (src/lib/doc-visibility.ts). Reading
// one signed out is the wiki's own read rule, which these functions stay
// outside of (docs/WIKI.md, "Public pages"). And a person's wiki page has no
// ADMIN/EDITOR bypass: canEditDocRow below states it, and editableDocsWhere
// carries it (docs/WIKI.md, "Permissions").
//
// `/docs` carries a "Show all docs" checkbox (src/app/docs/page.tsx) that
// widens what that one listing selects. It is not an argument to anything
// here and nothing in this file consults it, so every route gating on these
// functions — /doc/[slug], /doc/[slug]/edit, the collab token endpoint,
// annotations, doc-links, side-by-side, replay — answers the same with the
// box ticked as without it.
async function isDocAuthor(docId: string, userId: string): Promise<boolean> {
  const author = await prisma.docAuthor.findUnique({
    where: { docId_userId: { docId, userId } },
  });
  return !!author;
}

// Who may edit a SHARED doc they carry no byline on — the one place a role,
// rather than DocAuthor membership, still decides doc editing. A PRIVATE doc
// has no equivalent: its byline is the whole rule.
//
// A pure role check, and still here rather than in role-checks.ts, because
// what earns a place in that file is a client consumer — canViewDocs and
// canManageDocs are there for SiteHeader's sake, not for being about docs.
// Nothing in the browser asks this question, and both halves of the rule it
// expresses (canEditDocRow's SHARED branch and editableDocsWhere's carve-out)
// are in this file, so it belongs with them.
//
// The same two roles as canEditAnyPost, and deliberately *not* delegating to
// it. A delegation would keep exactly the coupling this separation exists to
// break — editing the post rule would silently move the doc rule with it.
// Stated independently, the two can diverge as a compile-time decision. If
// the doc side should ever differ, this is the function to change.
export function canEditAnySharedDoc(role: Role): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

/**
 * The editing rule over a doc already read: who may edit it, given its
 * visibility, its wiki owner and whether the user is on its byline. ADMIN and
 * EDITOR edit any SHARED (or PUBLIC) doc whatever its byline, except a
 * person's wiki page, whose byline alone edits it (docs/WIKI.md
 * "Permissions"): under `/wiki/@x/` the bypass would put other people's words
 * under x's name, and forking is how someone who disagrees changes it. A
 * PRIVATE doc is its byline's alone.
 *
 * canUserEditDoc asks this after its own read, doc-manage.ts after reading the
 * row under its lock, and the editor's gate and /docs' Edit link with the row
 * they already hold, so the rule is stated once. editableDocsWhere below is
 * the same rule as a filter.
 */
export function canEditDocRow(
  doc: { visibility: DocVisibility; wikiOwnerUserId: string | null; isAuthor: boolean },
  role: Role,
): boolean {
  if (!canManageDocs(role)) return false;
  if (doc.wikiOwnerUserId === null && isSharedOrPublic(doc.visibility) && canEditAnySharedDoc(role)) return true;
  return doc.isAuthor;
}

// Editing, by canEditDocRow's rule. One query reads the visibility, the wiki
// owner and author membership together, which is what lets the signature take
// a bare `docId` instead of making every call site fetch and pass them too.
//
// A soft-deleted doc answers false by default, through the filtered `prisma`,
// and some callers have no other deletion check: creating, publishing and
// scheduling a post from a doc take its id from the client and ask nothing
// else. `includeDeleted` is for restoring alone (setDocDeleted), which is by
// definition a question about a deleted row, so the filtered read would refuse
// every restore as a permission failure. canUserManageFile reads unfiltered
// unconditionally; this one can't, for the callers above.
export async function canUserEditDoc(
  userId: string,
  role: Role,
  docId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<boolean> {
  if (!canManageDocs(role)) {
    return false;
  }
  const args = {
    where: { id: docId },
    select: { visibility: true, wikiOwnerUserId: true, authors: { where: { userId }, select: { userId: true } } },
  } satisfies Prisma.DocFindUniqueArgs;
  const doc = opts.includeDeleted
    ? await prismaIncludingDeleted.doc.findUnique(args)
    : await prisma.doc.findUnique(args);
  if (!doc) return false;
  return canEditDocRow(
    { visibility: doc.visibility, wikiOwnerUserId: doc.wikiOwnerUserId, isAuthor: doc.authors.length > 0 },
    role,
  );
}

// Reading: canViewDocs is enough for a SHARED doc; a PRIVATE doc is readable
// by its listed authors only. The SHARED branch is the whole difference from
// canUserEditDoc — an AUTHORIZED reader passes here while being able to edit
// nothing (PLAN.md §12e's "two doc gates, easily conflated").
export async function canUserReadDoc(
  userId: string,
  role: Role,
  doc: { id: string; visibility: DocVisibility },
): Promise<boolean> {
  if (isSharedOrPublic(doc.visibility)) {
    return canViewDocs(role);
  }
  if (!canManageDocs(role)) {
    return false;
  }
  return isDocAuthor(doc.id, userId);
}

/**
 * docs/WIKI.md "Public pages" — **the wiki read rule**, a read rule of its own:
 * a viewer, who may be signed out, may read a wiki page when canUserReadDoc
 * says so, or when the page is live and PUBLIC. What reads by it: the wiki's
 * routes (the page, the namespace lists, /wiki), the family line on a wiki
 * page, the front page, and the redirect /doc/<slug> makes to a wiki page's
 * address.
 *
 * **It stays outside canUserReadDoc**, which every other gate on a doc is
 * built on — the collab token, replay, annotations, tags, search — and which
 * refuses a COMMENTER or a signed-out reader a PUBLIC page as it does a
 * SHARED one. So PUBLIC widens who reads the text, through these routes alone,
 * and nothing hanging off it.
 */
export async function canReadWikiDoc(
  viewer: { id: string; role: Role } | null,
  doc: { id: string; visibility: DocVisibility; wikiName: string | null; deletedByUserId: string | null },
): Promise<boolean> {
  if (doc.wikiName !== null && doc.visibility === "PUBLIC" && doc.deletedByUserId === null) return true;
  return viewer !== null && (await canUserReadDoc(viewer.id, viewer.role, doc));
}

/**
 * canReadWikiDoc as a `where`, beside it as CLAUDE.md asks of every read
 * rule. Not inside readableDocsWhere, which takes a user and returns null for
 * a viewer without canViewDocs, signed out or COMMENTER: exactly who this rule
 * exists for. Never null: anyone may read a live PUBLIC wiki page.
 */
export function readableWikiDocsWhere(viewer: { id: string; role: Role } | null): Prisma.DocWhereInput {
  const or: Prisma.DocWhereInput[] = [{ visibility: "PUBLIC", wikiName: { not: null } }];
  const readable = viewer ? readableDocsWhere(viewer.id, viewer.role) : null;
  if (readable) or.push(readable);
  return { deletedByUserId: null, OR: or };
}

export type ReadableDoc = { id: string; slug: string; title: string };

// PLAN.md §14k — every doc this viewer may read, through readableDocsWhere
// below: SHARED docs for anyone with canViewDocs, plus this user's own
// byline-authored PRIVATE ones. That function and canUserReadDoc above are
// the same rule twice, per row and as a filter — proximity plus this comment
// is the only thing keeping the two honest with each other, since Prisma has
// no way to share a boolean predicate between a per-row check and a query
// filter.
export async function readableDocsFor(userId: string, role: Role): Promise<ReadableDoc[]> {
  const where = readableDocsWhere(userId, role);
  if (!where) return [];

  return prisma.doc.findMany({
    where,
    select: { id: true, slug: true, title: true },
    orderBy: { title: "asc" },
  });
}

/**
 * canUserReadDoc as a `where` on Doc, for this viewer — **the one statement of
 * that rule as a filter**, which every listing of readable docs goes through:
 * the pickers below, `/tag/[slug]`, `/links`, `/annotations` (through
 * `readableAnnotationsWhere`) and search.
 *
 * Null means this viewer can read no doc at all; callers turn that into an
 * empty answer without touching the database, since an empty `OR` would match
 * everything in some Prisma versions and nothing in others.
 *
 * `deletedByUserId: null` is spelled out although prisma.ts's soft-delete
 * $extends adds it to every top-level read, because a relation filter
 * (`{ doc: readableDocsWhere(…) }`) goes around the extension.
 * `includeDeleted` leaves it out, for the one caller that lists rows hanging
 * off a deleted doc (`/annotations`); it widens nothing at the top level,
 * where the extension still applies.
 */
export function readableDocsWhere(
  userId: string,
  role: Role,
  opts: { includeDeleted?: boolean } = {},
): Prisma.DocWhereInput | null {
  const or: Prisma.DocWhereInput[] = [];
  if (canViewDocs(role)) or.push({ visibility: sharedOrPublic() });
  if (canManageDocs(role)) or.push({ visibility: "PRIVATE", authors: { some: { userId } } });
  if (or.length === 0) return null;
  return opts.includeDeleted ? { OR: or } : { deletedByUserId: null, OR: or };
}

// The link picker's row (LinkControls.tsx): a readable doc plus when it was
// last edited, which is what tells a dozen near-identical titles apart.
// `updatedAt` is a Date from these queries and an ISO string on the wire
// (LinkableDocJson) — the server action converts, so the client never
// depends on a Date surviving the action boundary.
//
// `label` is a wiki page's label, its address as stored (`@jane/Mercury
// (planet)~2`), null for a doc that isn't one: the `[[` menu's option shows
// it, since every variant of a name, and a page of that name in each
// namespace, share a title (docs/WIKI.md "Labels").
export type LinkableDoc = ReadableDoc & { updatedAt: Date; label: string | null };
export type LinkableDocJson = ReadableDoc & { updatedAt: string; label: string | null };

// The link bubble's preview of a linked doc (LinkBubble.tsx, fetched through
// previewLinkedDoc in src/app/actions/docs.ts): what the reading route's
// byline shows — the title, the authors in byline order, the last edit — as
// a block under the bubble's row, or "forbidden" for a doc that exists and
// isn't this viewer's to read, the same answer the route itself gives.
// Authors in the shape AuthorByline takes; updatedAt an ISO string on the
// wire, as LinkableDocJson's is.
export type LinkedDocPreview =
  | {
      status: "ok";
      title: string;
      authors: { userId: string; slug: string; name: string | null }[];
      updatedAt: string;
    }
  | { status: "forbidden" };

// How many rows the picker fetches. Inside the 5–10 band every mainstream
// link picker lands in; the dropdown shows about five and scrolls for the
// rest, so the cut is visible rather than a silent cap.
export const LINK_PICKER_LIMIT = 8;

const linkableSelect = {
  id: true,
  slug: true,
  title: true,
  updatedAt: true,
  wikiName: true,
  wikiVariant: true,
  wikiOwner: { select: { slug: true } },
} as const;

type LinkableRow = Prisma.DocGetPayload<{ select: typeof linkableSelect }>;

/** A picker's row, with a wiki page's label (docs/WIKI.md "Labels"). */
function linkable(row: LinkableRow): LinkableDoc {
  const address = wikiAddressOfDoc({ wikiName: row.wikiName, wikiVariant: row.wikiVariant, ownerSlug: row.wikiOwner?.slug ?? null });
  return { id: row.id, slug: row.slug, title: row.title, updatedAt: row.updatedAt, label: address && wikiLabel(address) };
}

// readableDocsFor's most recently edited rows — what the picker offers before
// anything is typed, since the doc someone wants to link is usually one they
// were just working on.
export async function recentReadableDocsFor(
  userId: string,
  role: Role,
  limit = LINK_PICKER_LIMIT,
): Promise<LinkableDoc[]> {
  const where = readableDocsWhere(userId, role);
  if (!where) return [];
  const rows = await prisma.doc.findMany({ where, select: linkableSelect, orderBy: { updatedAt: "desc" }, take: limit });
  return rows.map(linkable);
}

// readableDocsFor filtered by title: the top `limit` matches, title-prefix
// matches first. Two queries wearing the same predicate rather than one with
// a computed orderBy, because Prisma has no way to sort by "does the title
// start with the query" — the second query only runs when the first comes
// back short, and excludes the rows the first already returned.
export async function searchReadableDocsFor(
  userId: string,
  role: Role,
  query: string,
  limit = LINK_PICKER_LIMIT,
): Promise<LinkableDoc[]> {
  const where = readableDocsWhere(userId, role);
  if (!where) return [];

  const prefix = await prisma.doc.findMany({
    where: { ...where, title: { startsWith: query, mode: "insensitive" } },
    select: linkableSelect,
    orderBy: { title: "asc" },
    take: limit,
  });
  if (prefix.length >= limit) return prefix.map(linkable);

  const contains = await prisma.doc.findMany({
    where: {
      ...where,
      title: { contains: query, mode: "insensitive" },
      id: { notIn: prefix.map((doc) => doc.id) },
    },
    select: linkableSelect,
    orderBy: { title: "asc" },
    take: limit - prefix.length,
  });
  return [...prefix, ...contains].map(linkable);
}

/**
 * canUserEditDoc as a `where` on Doc, for this viewer, or null for one who
 * can edit no doc: the same relationship readableDocsWhere has to
 * canUserReadDoc, above, over canEditDocRow's rule. ADMIN/EDITOR get every
 * SHARED doc but a person's wiki page, which is its byline's, as a PRIVATE doc
 * is for every role. It feeds the history filter as well as the post
 * pickers, so the family line and the fork-point exception agree with the
 * per-row check.
 *
 * `deletedByUserId: null` is spelled out for the reason readableDocsWhere
 * gives: a relation filter goes around the soft-delete extension.
 */
function editableDocsWhere(userId: string, role: Role): Prisma.DocWhereInput | null {
  if (!canManageDocs(role)) return null;

  const or: Prisma.DocWhereInput[] = [{ authors: { some: { userId } } }];
  if (canEditAnySharedDoc(role)) or.push({ visibility: sharedOrPublic(), wikiOwnerUserId: null });
  return { deletedByUserId: null, OR: or };
}

// Backs the doc picker at /posts/new and "Change doc…" on /post/[id]/edit
// (PLAN.md §15d): only a doc its creator/publisher could open the editor for
// is offered, and no wiki page, which publishes nothing (docs/WIKI.md "Doc
// rules a wiki page doesn't inherit"). The `wikiName: null` is here and not on
// editableDocsWhere, which the history filter shares: there it would strip
// every wiki page's history from the family line.
export async function editableDocsFor(userId: string, role: Role): Promise<ReadableDoc[]> {
  const where = editableDocsWhere(userId, role);
  if (!where) return [];

  return prisma.doc.findMany({
    where: { ...where, wikiName: null },
    select: { id: true, slug: true, title: true },
    orderBy: { title: "asc" },
  });
}

// docs/FORKS.md "Who may see a doc's history" — a doc's history is any state
// of it but the current one: the scrub bar's replay, what changed since a
// version, a diff's versions.
//
// **An interim rule: a doc's history is its editors', and a fork point is
// also its fork's editors'.** These three functions are the whole of it, so that a change to who sees history is a change here
// and at no call site. Every check that *shows* history asks one of them, and
// never canUserEditDoc directly. A check that replays the log in order to
// *write* (publishing from a doc at a version on /post/[id]/edit, MCP's
// revert, an edit naming a passage by its ends) is an edit, and stays on
// canUserEditDoc.

/** Whether this viewer may see states of the doc other than its current one. A deleted doc answers false. */
export async function canUserSeeDocHistory(userId: string, role: Role, docId: string): Promise<boolean> {
  return canUserEditDoc(userId, role, docId);
}

/**
 * canUserSeeDocHistory as a `where` on Doc, or null for a viewer who sees no
 * doc's history: for a check that asks about several docs in one query.
 */
export function docsWithVisibleHistoryWhere(userId: string, role: Role): Prisma.DocWhereInput | null {
  return editableDocsWhere(userId, role);
}

/**
 * Whether this viewer may be shown the doc at `version`, in a diff. Ask it
 * **before** `isDocVersion`, never after: in the other order, Forbidden
 * against not-found tells a reader without the history which ids are in the
 * doc's log.
 *
 * The history predicate, or **the fork-point exception**: a fork point is not
 * history to the fork's editors. The doc at `version` is the first state of
 * any fork made of it there, which that fork's editors can already reach on
 * the fork's own scrub bar, so showing it tells them nothing they don't hold.
 * It is what lets an AUTHOR who forked a doc they can't edit see what its
 * author changed since. One query however many forks were made at the
 * version: a live fork of this doc, forked at exactly this version, among the
 * docs whose history the viewer may see, whose parent the viewer can read
 * now. The answer depends only on forks the viewer may already see into, so
 * it says nothing about this doc's log that those forks don't.
 *
 * **For diffs alone.** The doc's scrub bar, its `since` and forking it at a
 * version ask canUserSeeDocHistory, and stay its editors'.
 */
export async function canUserSeeDocVersion(userId: string, role: Role, docId: string, version: bigint): Promise<boolean> {
  if (await canUserSeeDocHistory(userId, role, docId)) return true;
  const historyWhere = docsWithVisibleHistoryWhere(userId, role);
  const readableWhere = readableDocsWhere(userId, role);
  if (!historyWhere || !readableWhere) return false;
  const fork = await prisma.doc.findFirst({
    where: { AND: [{ forkedFromDocId: docId, forkedFromUpdateId: version, forkedFrom: readableWhere }, historyWhere] },
    select: { id: true },
  });
  return fork !== null;
}
