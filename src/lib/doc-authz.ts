import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { canManageDocs, canViewDocs } from "@/lib/role-checks";

export { canManageDocs, canViewDocs } from "@/lib/role-checks";

// Per-doc access, on two axes (PLAN.md §12p):
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

// PLAN.md §14k — the same predicate canUserReadDoc checks per-row, expressed
// instead as a `where` clause: SHARED docs for anyone with canViewDocs, plus
// this user's own byline-authored PRIVATE ones. Backs the "Link to…" picker
// on /doc/[slug] — proximity to canUserReadDoc, plus this comment, is the
// only thing keeping the two honest with each other, since Prisma has no way
// to share a boolean predicate between a per-row check and a query filter.
export async function readableDocsFor(userId: string, role: Role): Promise<ReadableDoc[]> {
  const or: Prisma.DocWhereInput[] = [];
  if (canViewDocs(role)) or.push({ visibility: "SHARED" });
  if (canManageDocs(role)) or.push({ visibility: "PRIVATE", authors: { some: { userId } } });
  if (or.length === 0) return [];

  return prisma.doc.findMany({
    where: { deletedByUserId: null, OR: or },
    select: { id: true, slug: true, title: true },
    orderBy: { title: "asc" },
  });
}

// canUserEditDoc expressed as a `where` clause — the same relationship
// readableDocsFor has to canUserReadDoc, above. Backs the doc picker at
// /posts/new and "Change doc…" on /posts/[id]/edit (PLAN.md §15d): only a doc
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
