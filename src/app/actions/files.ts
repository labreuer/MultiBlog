"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canUserManageFile } from "@/lib/file-authz";
import { revertFileSlug as revertFileSlugInDb } from "@/lib/file-slug";
import { setFileDeleted, setFileSlug, setFileTitle, setFileVisibility } from "@/lib/file-manage";
import { actorFromSessionUser } from "@/lib/actor";
import { DocVisibility } from "@/generated/prisma/enums";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

// PLAN.md §19 — mutations on an uploaded file. Deliberately the doc actions'
// shape (src/app/actions/docs.ts), minus everything about content: a file has
// no body to create, edit or seed, so there is no createFile here — uploading
// *is* creation, and it happens in the route handler that receives the bytes.
//
// The bodies are src/lib/file-manage.ts's, which the MCP server shares; these
// add the session and the /files revalidation.

async function sessionActor() {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  return actorFromSessionUser(session.user);
}

export async function updateFileVisibility(fileId: string, visibility: DocVisibility): Promise<void> {
  await setFileVisibility(await sessionActor(), fileId, visibility);
  revalidatePath("/files");
}

export async function updateFileTitle(fileId: string, title: string): Promise<void> {
  await setFileTitle(await sessionActor(), fileId, title);
  revalidatePath("/files");
}

export async function updateFileSlug(fileId: string, newSlug: string): Promise<{ slug: string }> {
  const slug = await setFileSlug(await sessionActor(), fileId, newSlug);
  revalidatePath("/files");
  return { slug };
}

export async function revertFileSlug(fileId: string): Promise<{ slug: string }> {
  const actor = await sessionActor();
  const file = await prismaIncludingDeleted.storedFile.findUnique({ where: { id: fileId }, select: { id: true } });
  if (!file) {
    throw new Error("File not found.");
  }
  if (!(await canUserManageFile(actor.userId, actor.role, fileId))) {
    throw new Error("You don't have permission to manage this file.");
  }
  const slug = await revertFileSlugInDb(fileId, actor.userId);
  revalidatePath("/files");
  return { slug };
}

/** Soft-deletes or restores (`setFileDeleted`, which renames a restored file whose url was taken meanwhile). */
async function setFileDeletedAction(fileId: string, deleted: boolean): Promise<{ slug: string; renamedFrom: string | null }> {
  const result = await setFileDeleted(await sessionActor(), fileId, deleted);
  revalidatePath("/files");
  return result;
}

export async function deleteFile(fileId: string): Promise<void> {
  await setFileDeletedAction(fileId, true);
}

export async function restoreFile(fileId: string): Promise<{ slug: string; renamedFrom: string | null }> {
  return setFileDeletedAction(fileId, false);
}

// Per-row rather than one transaction — see bulkDeletePosts for the rationale.
export async function bulkDeleteFiles(fileIds: string[]): Promise<BulkResult> {
  return settleBulk(fileIds, (id) => setFileDeletedAction(id, true));
}

export async function bulkRestoreFiles(fileIds: string[]): Promise<BulkResult> {
  return settleBulk(fileIds, (id) => setFileDeletedAction(id, false));
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
