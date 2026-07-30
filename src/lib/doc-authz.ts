import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost, canManageDocs, canViewDocs } from "@/lib/role-checks";

export { canManageDocs, canViewDocs } from "@/lib/role-checks";

// Mirrors canUserEditPost (src/lib/authz.ts): ADMIN/EDITOR edit any doc; an
// AUTHOR must be a byline author of this particular doc.
export async function canUserEditDoc(userId: string, role: Role, docId: string): Promise<boolean> {
  if (canEditAnyPost(role)) {
    return true;
  }
  if (role !== "AUTHOR") {
    return false;
  }
  const author = await prisma.docAuthor.findUnique({
    where: { docId_userId: { docId, userId } },
  });
  return !!author;
}

// Whether userId/role may *read* doc — canViewDocs on a SHARED doc for
// anyone, or (PRIVATE) byline authors plus ADMIN/EDITOR. Distinct from
// canUserEditDoc: an AUTHORIZED reader satisfies this without being able to
// edit anything (PLAN.md §12e's "two doc gates, easily conflated").
export async function canUserReadDoc(
  userId: string,
  role: Role,
  doc: { id: string; visibility: "PRIVATE" | "SHARED" },
): Promise<boolean> {
  if (canEditAnyPost(role)) {
    return true;
  }
  if (doc.visibility === "SHARED") {
    return canViewDocs(role);
  }
  if (!canManageDocs(role)) {
    return false;
  }
  const author = await prisma.docAuthor.findUnique({
    where: { docId_userId: { docId: doc.id, userId } },
  });
  return !!author;
}

export type ReadableDoc = { id: string; slug: string; title: string };

// PLAN.md §14k — the same predicate canUserReadDoc checks per-row, expressed
// instead as a `where` clause: ADMIN/EDITOR get every non-deleted doc;
// everyone else gets SHARED docs plus their own byline-authored PRIVATE
// ones. Backs the "Link to…" picker on /doc/[slug] — proximity to
// canUserReadDoc, plus this comment, is the only thing keeping the two
// honest with each other, since Prisma has no way to share a boolean
// predicate between a per-row check and a query filter.
export async function readableDocsFor(userId: string, role: Role): Promise<ReadableDoc[]> {
  if (canEditAnyPost(role)) {
    return prisma.doc.findMany({
      where: { deletedByUserId: null },
      select: { id: true, slug: true, title: true },
      orderBy: { title: "asc" },
    });
  }

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
