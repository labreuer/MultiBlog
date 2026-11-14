"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canUserManageFile } from "@/lib/file-authz";
import { revertFileSlug as revertFileSlugInDb } from "@/lib/file-slug";
import {
  abandonFileVersion,
  answerFileVersionMapRun,
  buildFileVersionMap,
  promoteFileVersion,
  setFileDeleted,
  setFileSlug,
  setFileTitle,
  setFileVisibility,
} from "@/lib/file-manage";
import { actorFromSessionUser, type Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
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

/** What a version's action answers: where the file is now, or why nothing was done, in words for whoever clicked. */
export type VersionActionResult = { ok: true; slug: string; number: number } | { ok: false; error: string };

/**
 * A refusal as an answer, not a throw: a production build hides a thrown
 * error's message from the browser, and these refusals (the version is no
 * longer the candidate, the file is deleted) are what the manager needs to
 * read.
 */
async function versionAction(run: (actor: Actor) => Promise<{ slug: string; number: number }>): Promise<VersionActionResult> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "You are signed out. Sign in, then try again." };
  try {
    const done = await run(actorFromSessionUser(session.user));
    revalidatePath("/files");
    return { ok: true, ...done };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    console.error("[files] a version's action failed:", err);
    return { ok: false, error: "That didn't work. Reload the page and try again." };
  }
}

/** Makes a waiting version the file's latest (docs/PDF.md §13, "Promotion"). It names the version, never "the candidate". */
export async function promoteVersion(versionId: string): Promise<VersionActionResult> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return versionAction((actor) => promoteFileVersion(actor, versionId));
}

/** Abandons a waiting version: its bytes and page text go, its number and its address stay (docs/PDF.md §13, "The upload"). */
export async function abandonVersion(versionId: string): Promise<VersionActionResult> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return versionAction((actor) => abandonFileVersion(actor, versionId));
}

/**
 * Stores the page map between a version and the one it was uploaded over,
 * where it has none (docs/PDF.md §13, "Matching the pages"): the act that
 * says the two hold the same text.
 */
export async function buildVersionMap(versionId: string): Promise<VersionActionResult> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return versionAction((actor) => buildFileVersionMap(actor, versionId));
}

/** Accepts or declines one run of sheets of a version's page map. */
export async function answerVersionMapRun(versionId: string, runIndex: number, accepted: boolean): Promise<VersionActionResult> {
  if (typeof versionId !== "string" || typeof runIndex !== "number" || typeof accepted !== "boolean") return { ok: false, error: "That isn't a question of this page map." };
  return versionAction((actor) => answerFileVersionMapRun(actor, versionId, runIndex, accepted));
}
