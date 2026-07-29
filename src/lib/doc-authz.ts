import type { Role } from "@/generated/prisma/enums";
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
