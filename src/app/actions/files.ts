"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canUserManageFile } from "@/lib/file-authz";
import { changeFileSlug, revertFileSlug as revertFileSlugInDb } from "@/lib/file-slug";
import { DocVisibility } from "@/generated/prisma/enums";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

// PLAN.md §19 — mutations on an uploaded file. Deliberately the doc actions'
// shape (src/app/actions/docs.ts), minus everything about content: a file has
// no body to create, edit or seed, so there is no createFile here — uploading
// *is* creation, and it happens in the route handler that receives the bytes.
//
// Deleting is a soft delete only. The bytes stay on disk: they are
// content-addressed and may be shared with another file (src/lib/file-storage.ts),
// and a soft delete is meant to be undoable, which it wouldn't be if restoring
// left a row pointing at bytes that had been swept. A hard delete that also
// reclaims storage is deliberately not built.

async function requireManageableFile(fileId: string) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  // prismaIncludingDeleted, so restoring a deleted file can find it — the same
  // reason setDocDeleted uses it.
  const file = await prismaIncludingDeleted.storedFile.findUnique({ where: { id: fileId } });
  if (!file) {
    throw new Error("File not found.");
  }
  if (!(await canUserManageFile(session.user.id, session.user.role, fileId))) {
    throw new Error("You don't have permission to manage this file.");
  }
  return { session, file };
}

export async function updateFileVisibility(fileId: string, visibility: DocVisibility): Promise<void> {
  const { session } = await requireManageableFile(fileId);
  if (!Object.values(DocVisibility).includes(visibility)) {
    throw new Error("Invalid visibility.");
  }
  await prismaIncludingDeleted.storedFile.update({
    where: { id: fileId },
    data: { visibility, updatedByUserId: session.user.id },
  });
  revalidatePath("/files");
}

export async function updateFileTitle(fileId: string, title: string): Promise<void> {
  const { session } = await requireManageableFile(fileId);
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("A file needs a title.");
  }
  await prismaIncludingDeleted.storedFile.update({
    where: { id: fileId },
    data: { title: trimmed.slice(0, 500), updatedByUserId: session.user.id },
  });
  revalidatePath("/files");
}

export async function updateFileSlug(fileId: string, newSlug: string): Promise<{ slug: string }> {
  const { session } = await requireManageableFile(fileId);
  const slug = await changeFileSlug(fileId, newSlug, session.user.id);
  revalidatePath("/files");
  return { slug };
}

export async function revertFileSlug(fileId: string): Promise<{ slug: string }> {
  const { session } = await requireManageableFile(fileId);
  const slug = await revertFileSlugInDb(fileId, session.user.id);
  revalidatePath("/files");
  return { slug };
}

async function setFileDeleted(fileId: string, deleted: boolean): Promise<void> {
  const { session } = await requireManageableFile(fileId);
  await prismaIncludingDeleted.storedFile.update({
    where: { id: fileId },
    data: deleted
      ? { deletedByUserId: session.user.id, deletedAt: new Date(), updatedByUserId: session.user.id }
      : { deletedByUserId: null, deletedAt: null, updatedByUserId: session.user.id },
  });
  revalidatePath("/files");
}

export async function deleteFile(fileId: string): Promise<void> {
  await setFileDeleted(fileId, true);
}

export async function restoreFile(fileId: string): Promise<void> {
  await setFileDeleted(fileId, false);
}

// Per-row rather than one transaction — see bulkDeletePosts for the rationale.
export async function bulkDeleteFiles(fileIds: string[]): Promise<BulkResult> {
  return settleBulk(fileIds, (id) => setFileDeleted(id, true));
}

export async function bulkRestoreFiles(fileIds: string[]): Promise<BulkResult> {
  return settleBulk(fileIds, (id) => setFileDeleted(id, false));
}

export async function bulkSetFileVisibility(fileIds: string[], visibility: DocVisibility): Promise<BulkResult> {
  return settleBulk(fileIds, (id) => updateFileVisibility(id, visibility));
}

/**
 * Drops the cached /files listing after an upload. The uploader POSTs its
 * bytes to a Route Handler, which — unlike a Server Action — has no way to
 * revalidate the page that triggered it, so this is the one call that closes
 * that loop.
 *
 * No per-file authorization: it revalidates a listing whose own query is
 * already scoped per viewer, so it reveals nothing and can't act on a row.
 */
export async function refreshFilesListing(): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  revalidatePath("/files");
}
