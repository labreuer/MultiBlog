import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { canManageDocs, canViewDocs } from "@/lib/role-checks";

export { canManageDocs, canViewDocs } from "@/lib/role-checks";

// Per-doc access, on two axes (docs/PERMISSIONS.md):
//
//   SHARED   read by anyone with canViewDocs; edit by ADMIN/EDITOR whatever
//            the byline says, or by any listed author.
//   PRIVATE  read and edit by its listed DocAuthors alone — every role,
//            ADMIN and EDITOR included.
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
// expresses (canUserEditDoc's SHARED branch and editableDocsFor's carve-out)
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

// Editing: ADMIN/EDITOR edit any SHARED doc; a PRIVATE doc is editable by its
// listed authors only. One query reads the visibility and tests author
// membership together, which is what lets the signature take a bare `docId`
// instead of making every call site fetch and pass the visibility too.
export async function canUserEditDoc(userId: string, role: Role, docId: string): Promise<boolean> {
  if (!canManageDocs(role)) {
    return false;
  }
  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    select: { visibility: true, authors: { where: { userId }, select: { userId: true } } },
  });
  if (!doc) return false;
  if (doc.visibility === "SHARED" && canEditAnySharedDoc(role)) {
    return true;
  }
  return doc.authors.length > 0;
}

// Reading: canViewDocs is enough for a SHARED doc; a PRIVATE doc is readable
// by its listed authors only. The SHARED branch is the whole difference from
// canUserEditDoc — an AUTHORIZED reader passes here while being able to edit
// nothing (PLAN.md §12e's "two doc gates, easily conflated").
export async function canUserReadDoc(
  userId: string,
  role: Role,
  doc: { id: string; visibility: "PRIVATE" | "SHARED" },
): Promise<boolean> {
  if (doc.visibility === "SHARED") {
    return canViewDocs(role);
  }
  if (!canManageDocs(role)) {
    return false;
  }
  return isDocAuthor(doc.id, userId);
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
  if (canViewDocs(role)) or.push({ visibility: "SHARED" });
  if (canManageDocs(role)) or.push({ visibility: "PRIVATE", authors: { some: { userId } } });
  if (or.length === 0) return null;
  return opts.includeDeleted ? { OR: or } : { deletedByUserId: null, OR: or };
}

// The link picker's row (LinkControls.tsx): a readable doc plus when it was
// last edited, which is what tells a dozen near-identical titles apart.
// `updatedAt` is a Date from these queries and an ISO string on the wire
// (LinkableDocJson) — the server action converts, so the client never
// depends on a Date surviving the action boundary.
export type LinkableDoc = ReadableDoc & { updatedAt: Date };
export type LinkableDocJson = ReadableDoc & { updatedAt: string };

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

const linkableSelect = { id: true, slug: true, title: true, updatedAt: true } as const;

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
  return prisma.doc.findMany({ where, select: linkableSelect, orderBy: { updatedAt: "desc" }, take: limit });
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
  if (prefix.length >= limit) return prefix;

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
  return [...prefix, ...contains];
}

// canUserEditDoc expressed as a `where` clause — the same relationship
// readableDocsFor has to canUserReadDoc, above. Backs the doc picker at
// /posts/new and "Change doc…" on /post/[id]/edit (PLAN.md §15d): only a doc
// its creator/publisher could open the editor for is offered. ADMIN/EDITOR
// get every SHARED doc as a candidate; PRIVATE candidates are this user's own
// byline, for every role.
export async function editableDocsFor(userId: string, role: Role): Promise<ReadableDoc[]> {
  if (!canManageDocs(role)) return [];

  const or: Prisma.DocWhereInput[] = [{ authors: { some: { userId } } }];
  if (canEditAnySharedDoc(role)) or.push({ visibility: "SHARED" });

  return prisma.doc.findMany({
    where: { deletedByUserId: null, OR: or },
    select: { id: true, slug: true, title: true },
    orderBy: { title: "asc" },
  });
}
