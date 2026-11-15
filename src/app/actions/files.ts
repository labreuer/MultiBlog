"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import {
  abandonFileVersion,
  answerFileVersionMapRun,
  unpairFileVersionMapRun,
  promoteFileVersion,
  revertFileSlugAs,
  setFileDeleted,
  setFileOwners,
  setFileSlug,
  setFileTitle,
  setFileVisibility,
} from "@/lib/file-manage";
import {
  carryFromVersion,
  previewCarryFromVersion,
  setCarryHidden,
  type CarryPreview,
  type CarryResult,
} from "@/lib/file-anchor-move";
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

// ---------------------------------------------------------------------------
// docs/PDF.md §14 — the actions a file's manage page (/files/<id>/manage)
// calls. **Each answers a refusal and throws none**: a production build
// replaces a thrown error's message before it reaches the browser, and these
// refusals (the url is taken, the owner list changed, a file needs a title)
// are what the manager has to read. /files' cells keep the throwing actions
// above, which they catch as every admin table's cells do.

/** What a manage page's action answers: what was done, or why not, in words for whoever clicked. */
export type FileAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

/** A refusal is an ApiError's message; anything else is a fault, logged and answered in a line that says to reload. */
async function answering<T>(what: string, run: (actor: Actor) => Promise<T>): Promise<FileAnswer<T>> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "You are signed out. Sign in, then try again." };
  try {
    return { ok: true, value: await run(actorFromSessionUser(session.user)) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    console.error(`[files] ${what} failed:`, err);
    return { ok: false, error: "That didn't work. Reload the page and try again." };
  }
}

/** /files and the file's manage page, after a manage page's act. */
function revalidateManaged(fileId: string): void {
  revalidatePath("/files");
  revalidatePath(`/files/${fileId}/manage`);
}

/** The acts of the manage page: each checks its arguments' types, since an action is sent whatever JSON its caller likes. */
async function manageAnswer<T>(fileId: unknown, what: string, run: (actor: Actor, fileId: string) => Promise<T>): Promise<FileAnswer<T>> {
  if (typeof fileId !== "string") return { ok: false, error: "That isn't a file." };
  const answer = await answering(what, (actor) => run(actor, fileId));
  if (answer.ok) revalidateManaged(fileId);
  return answer;
}

/** A file's title, trimmed; answers the title it now has. */
export async function updateFileTitle(fileId: string, title: string): Promise<FileAnswer<{ title: string }>> {
  if (typeof title !== "string") return { ok: false, error: "A file needs a title." };
  return manageAnswer(fileId, "a title's save", async (actor, id) => ({ title: await setFileTitle(actor, id, title) }));
}

/** A file's slug, the old one kept as a past one; refused for a deleted file. */
export async function updateFileSlug(fileId: string, newSlug: string): Promise<FileAnswer<{ slug: string }>> {
  if (typeof newSlug !== "string") return { ok: false, error: "That isn't a url." };
  return manageAnswer(fileId, "a slug's change", async (actor, id) => ({ slug: await setFileSlug(actor, id, newSlug) }));
}

/** A file's slug put back to its most recent past one; refused for a deleted file. */
export async function revertFileSlug(fileId: string): Promise<FileAnswer<{ slug: string }>> {
  return manageAnswer(fileId, "a slug's revert", async (actor, id) => ({ slug: await revertFileSlugAs(actor, id) }));
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

/**
 * A file's whole owner list, in order, saved once. `expected` is the list the
 * page's edit started from: one someone else changed since is refused, not
 * overwritten (`setFileOwners`). Removals are what the page has already said
 * the cost of, so they are allowed.
 */
export async function updateFileOwners(fileId: string, orderedUserIds: string[], expected: string[]): Promise<FileAnswer<null>> {
  if (!isIdList(orderedUserIds) || !isIdList(expected)) return { ok: false, error: "That isn't a list of owners." };
  return manageAnswer(fileId, "an owner list's save", async (actor, id) => {
    await setFileOwners(actor, id, orderedUserIds, { allowRemovals: true, expected });
    return null;
  });
}

/** A file's visibility, from its manage page. */
export async function manageFileVisibility(fileId: string, visibility: DocVisibility): Promise<FileAnswer<null>> {
  return manageAnswer(fileId, "a visibility's change", async (actor, id) => {
    await setFileVisibility(actor, id, visibility);
    return null;
  });
}

/** Deletes or restores a file from its manage page; a restore answers the slug it came back under and the one it lost, if any. */
export async function manageFileDeleted(fileId: string, deleted: boolean): Promise<FileAnswer<{ slug: string; renamedFrom: string | null }>> {
  if (typeof deleted !== "boolean") return { ok: false, error: "That isn't a delete or a restore." };
  return manageAnswer(fileId, deleted ? "a delete" : "a restore", (actor, id) => setFileDeleted(actor, id, deleted));
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
export type VersionActionResult = { ok: true; slug: string; number: number; carried?: CarryResult | null } | { ok: false; error: string };

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
export async function promoteVersion(versionId: string, carry: boolean = false): Promise<VersionActionResult> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return versionAction((actor) => promoteFileVersion(actor, versionId, { carry: carry === true }));
}

/** Abandons a waiting version: its bytes and page text go, its number and its address stay (docs/PDF.md §13, "The upload"). */
export async function abandonVersion(versionId: string): Promise<VersionActionResult> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return versionAction((actor) => abandonFileVersion(actor, versionId));
}

/** Accepts or declines one run of sheets of a version's page map. */
export async function answerVersionMapRun(versionId: string, runIndex: number, accepted: boolean): Promise<VersionActionResult> {
  if (typeof versionId !== "string" || typeof runIndex !== "number" || typeof accepted !== "boolean") return { ok: false, error: "That isn't a question of this page map." };
  return versionAction((actor) => answerFileVersionMapRun(actor, versionId, runIndex, accepted));
}

/** Un-pairs one run of sheets a manager paired, making it a question again. */
export async function unpairVersionMapRun(versionId: string, runIndex: number): Promise<VersionActionResult> {
  if (typeof versionId !== "string" || typeof runIndex !== "number") return { ok: false, error: "That isn't a question of this page map." };
  return versionAction((actor) => unpairFileVersionMapRun(actor, versionId, runIndex));
}

// A page map's build and a promotion's carry preview are not actions: each
// takes seconds and nobody waits on it, so each is a Route Handler under
// /api/files/versions/<id>/ (docs/PDF.md §14, item 6), which doesn't hold the
// page's other saves behind it as an action would.

/** What an action about a carry answers: what was asked for, or why not, in words for whoever clicked. */
export type CarryAnswer<T> = FileAnswer<T>;

async function carryAction<T>(run: (actor: Actor) => Promise<T>): Promise<CarryAnswer<T>> {
  return answering("a carry's action", run);
}

/** What a carry started on one earlier version would do: the page maps it would store and the notes it would move. It stores nothing. */
export async function previewVersionCarry(versionId: string): Promise<CarryAnswer<CarryPreview>> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return carryAction((actor) => previewCarryFromVersion(actor, versionId));
}

/** Runs the carry a manager starts on one earlier version, and answers what it did. */
export async function carryVersionNotes(versionId: string): Promise<CarryAnswer<CarryResult>> {
  if (typeof versionId !== "string") return { ok: false, error: "That isn't a version." };
  return carryAction((actor) => carryFromVersion(actor, versionId));
}

/** Shows or hides the moves of one carry together. */
export async function setCarryMovesHidden(carryId: string, hidden: boolean): Promise<CarryAnswer<{ changed: number }>> {
  if (typeof carryId !== "string" || typeof hidden !== "boolean") return { ok: false, error: "That isn't a carry." };
  return carryAction(async (actor) => ({ changed: (await setCarryHidden(actor, carryId, hidden)).changed }));
}
