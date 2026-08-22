import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { canManageFiles, canViewFiles } from "@/lib/role-checks";

export { canManageFiles, canViewFiles } from "@/lib/role-checks";

// PLAN.md §19 — per-file access, deliberately the same two axes docs have
// (docs/PERMISSIONS.md), function for function against src/lib/doc-authz.ts:
//
//   SHARED   read by anyone with canViewFiles; managed by ADMIN/EDITOR
//            whatever the owner list says, or by any listed owner.
//   PRIVATE  read and managed by its listed FileOwners alone — every role,
//            ADMIN and EDITOR included.
//
// The parallel is intentional and the *duplication* is too: this file restates
// doc-authz.ts's rules rather than calling into them, so that the file rule and
// the doc rule can diverge without one silently dragging the other. The same
// reasoning role-checks.ts gives for canManageFiles not delegating to
// canManageDocs.
//
// The one structural difference from docs: there is no "edit the content"
// gate, because a file has no editable content — its bytes are immutable by
// construction. `canUserManageFile` covers what canUserEditDoc covers minus
// that: renaming, re-slugging, changing visibility and owners, deleting.
//
// The one vocabulary difference from docs is deliberate: a file's listed users
// are its *owners*, not its authors (prisma/schema.prisma's FileOwner), since
// nobody in that list wrote the PDF — the list is seeded with the uploader and
// editable afterwards, and what it confers is control, not credit.
//
// `/files` carries an ADMIN-only "Show all files" checkbox
// (src/app/files/page.tsx) that widens what that one listing selects. It is not
// an argument to anything here and nothing in this file consults it, so
// /pdf/[slug] and the download route answer the same with the box ticked as
// without it.
async function isFileOwner(fileId: string, userId: string): Promise<boolean> {
  const owner = await prisma.fileOwner.findUnique({
    where: { fileId_userId: { fileId, userId } },
  });
  return !!owner;
}

// Who may manage a SHARED file they are not an owner of — the file counterpart
// of canEditAnySharedDoc, here rather than in role-checks.ts for the same
// reason that one is in doc-authz.ts: nothing in the browser asks this
// question.
export function canManageAnySharedFile(role: Role): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

/** Reading: what /pdf/[slug] and the download route gate on. */
export async function canUserReadFile(
  userId: string,
  role: Role,
  file: { id: string; visibility: "PRIVATE" | "SHARED" },
): Promise<boolean> {
  if (file.visibility === "SHARED") {
    return canViewFiles(role);
  }
  if (!canManageFiles(role)) {
    return false;
  }
  return isFileOwner(file.id, userId);
}

/** Managing: rename, re-slug, change visibility/owners, delete. */
export async function canUserManageFile(userId: string, role: Role, fileId: string): Promise<boolean> {
  if (!canManageFiles(role)) {
    return false;
  }
  const file = await prisma.storedFile.findUnique({
    where: { id: fileId },
    select: { visibility: true, owners: { where: { userId }, select: { userId: true } } },
  });
  if (!file) return false;
  if (file.visibility === "SHARED" && canManageAnySharedFile(role)) {
    return true;
  }
  return file.owners.length > 0;
}

export type ReadableFile = { id: string; slug: string; title: string };

// canUserReadFile expressed as a `where` clause — the same relationship
// readableDocsFor has to canUserReadDoc, and with the same caveat: Prisma has
// no way to share a boolean predicate between a per-row check and a query
// filter, so proximity plus this comment is all that keeps the two honest.
export async function readableFilesFor(userId: string, role: Role): Promise<ReadableFile[]> {
  const or: Prisma.StoredFileWhereInput[] = [];
  if (canViewFiles(role)) or.push({ visibility: "SHARED" });
  if (canManageFiles(role)) or.push({ visibility: "PRIVATE", owners: { some: { userId } } });
  if (or.length === 0) return [];

  return prisma.storedFile.findMany({
    where: { deletedByUserId: null, OR: or },
    select: { id: true, slug: true, title: true },
    orderBy: { title: "asc" },
  });
}
