import { prisma, prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import { lockFileHash, lockFileRow } from "@/lib/file-version-data";
import { deleteBytesIfUnreferenced } from "@/lib/file-storage";
import { storePageMap, storeRunAnswer } from "@/lib/pdf-page-map-build";
import { pageMapNumbers, type PageMapNumbers } from "@/lib/pdf-page-map";

// How long a version's write may wait for the file row or a hash: Prisma's
// default, five seconds, is less than an upload's insert of a large book's
// page text can hold either. The upload's own transactions take the same
// (`VERSION_WRITE_TIMEOUTS`, file-ingest.ts, which imports nothing from here).
const VERSION_WRITE_TIMEOUTS = { maxWait: 30_000, timeout: 60_000 } as const;
import { canUserManageFile } from "@/lib/file-authz";
import { changeFileSlug, freeFileSlugFor } from "@/lib/file-slug";
import { FILE_MANAGER_ROLES } from "@/lib/role-checks";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import type { DocVisibility } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/actor";

// Managing an uploaded file — its visibility, title, slug, owners, soft
// deletion and the promotion or abandoning of a waiting version — as plain functions taking an explicit actor, the file
// counterpart of src/lib/doc-manage.ts: /files' actions
// (src/app/actions/files.ts) wrap them with the session, and the MCP
// server's `manage` and `rename_file` with a token's user. Each refusal is an
// ApiError, whose message reads the same in either front door.
//
// Deleting is a soft delete only. The bytes stay on disk: they are
// content-addressed and may be shared with another file
// (src/lib/file-storage.ts), and a soft delete is meant to be undoable.

/** The file, found deleted or not (restoring needs the deleted row), and the actor's right to manage it. */
async function requireManageable(actor: Actor, fileId: string): Promise<{ slug: string }> {
  const file = await prismaIncludingDeleted.storedFile.findUnique({ where: { id: fileId }, select: { slug: true } });
  if (!file) throw new ApiError("not_found", "File not found.");
  if (!(await canUserManageFile(actor.userId, actor.role, fileId))) {
    throw forbidden("You don't have permission to manage this file.");
  }
  return file;
}

export async function setFileVisibility(actor: Actor, fileId: string, visibility: DocVisibility): Promise<void> {
  await requireManageable(actor, fileId);
  if (visibility !== "PRIVATE" && visibility !== "SHARED") throw invalid("Invalid visibility.");
  await prismaIncludingDeleted.storedFile.update({ where: { id: fileId }, data: { visibility, updatedByUserId: actor.userId } });
}

/** A file's title, trimmed and capped. It keeps no history, which is why rename_file prompts. */
export async function setFileTitle(actor: Actor, fileId: string, title: string): Promise<string> {
  await requireManageable(actor, fileId);
  const trimmed = title.trim().slice(0, 500);
  if (!trimmed) throw invalid("A file needs a title.");
  await prismaIncludingDeleted.storedFile.update({ where: { id: fileId }, data: { title: trimmed, updatedByUserId: actor.userId } });
  return trimmed;
}

/** Renames a file's slug, the old one kept in its history; returns the slug it now has. */
export async function setFileSlug(actor: Actor, fileId: string, slug: string): Promise<string> {
  await requireManageable(actor, fileId);
  try {
    return await changeFileSlug(fileId, slug, actor.userId);
  } catch (err) {
    // changeFileSlug's own refusals (taken, gone) are plain Errors written
    // for the reader. Anything else, a Prisma rejection included, is a
    // fault, and its message is no answer to give.
    if (err instanceof Error && err.name === "Error") throw new ApiError("conflict", err.message);
    throw err;
  }
}

/**
 * A file's owners, as the ordered list `orderedUserIds` — `setDocByline`'s
 * rules read for a file (docs/MCP.md §12): the actor can manage it; everyone
 * it adds is a live account in `FILE_MANAGER_ROLES`, and someone already on
 * it stays eligible to stay; at least one owner remains; a removal takes
 * `allowRemovals`, since on a PRIVATE file the owners are who can read it;
 * one transaction.
 */
export async function setFileOwners(
  actor: Actor,
  fileId: string,
  orderedUserIds: readonly string[],
  opts: { allowRemovals?: boolean } = {},
): Promise<void> {
  await requireManageable(actor, fileId);
  const wanted = [...new Set(orderedUserIds)];
  if (wanted.length === 0) throw invalid("A file must have at least one owner.");
  if (wanted.length !== orderedUserIds.length) throw invalid("An owner list names each person once.");

  await prisma.$transaction(async (tx) => {
    const current = new Set((await tx.fileOwner.findMany({ where: { fileId }, select: { userId: true } })).map((o) => o.userId));
    const added = wanted.filter((id) => !current.has(id));
    const users = await tx.user.findMany({ where: { id: { in: added } }, select: { id: true, role: true } });
    const eligible = new Set(users.filter((u) => FILE_MANAGER_ROLES.includes(u.role)).map((u) => u.id));
    const ineligible = added.filter((id) => !eligible.has(id));
    if (ineligible.length > 0) {
      throw invalid("Only an admin, editor or author account can own a file.", { userIds: ineligible.slice(0, 5) });
    }
    const removed = [...current].filter((id) => !wanted.includes(id));
    if (removed.length > 0 && !opts.allowRemovals) {
      throw invalid("That owner list leaves someone off it, which on a PRIVATE file takes their access away; pass allowRemovals to mean it.", {
        removing: removed,
      });
    }
    if (removed.length > 0) await tx.fileOwner.deleteMany({ where: { fileId, userId: { in: removed } } });
    for (const [ownerOrder, userId] of wanted.entries()) {
      await tx.fileOwner.upsert({
        where: { fileId_userId: { fileId, userId } },
        create: { fileId, userId, ownerOrder },
        update: { ownerOrder },
      });
    }
    await tx.storedFile.update({ where: { id: fileId }, data: { updatedByUserId: actor.userId } });
  });
}

/**
 * Soft-deletes or restores, and — on the way back — settles the slug.
 *
 * Deleting a file releases its url (`file_slug_live_key` is unique only among
 * live files, src/lib/file-slug.ts), which is the point: the reason to delete a
 * PDF is usually to upload a corrected copy of it, and that copy should be able
 * to have the name. If the url has been taken by the time someone restores,
 * the restored file is **renamed** — `report` comes back as `report-2` —
 * rather than refused; `renamedFrom` says so.
 */
export async function setFileDeleted(
  actor: Actor,
  fileId: string,
  deleted: boolean,
): Promise<{ slug: string; renamedFrom: string | null }> {
  const file = await requireManageable(actor, fileId);
  if (deleted) {
    await prismaIncludingDeleted.storedFile.update({
      where: { id: fileId },
      data: { deletedByUserId: actor.userId, deletedAt: new Date(), updatedByUserId: actor.userId },
    });
    return { slug: file.slug, renamedFrom: null };
  }
  const slug = await prismaIncludingDeleted.$transaction(async (tx) => {
    const claimed = await freeFileSlugFor(tx, fileId, file.slug);
    await tx.storedFile.update({
      where: { id: fileId },
      data: { deletedByUserId: null, deletedAt: null, updatedByUserId: actor.userId, slug: claimed },
    });
    return claimed;
  });
  return { slug, renamedFrom: slug === file.slug ? null : file.slug };
}

// ---------------------------------------------------------------------------
// docs/PDF.md §13 — a candidate version's two ends: promoted, which makes it
// the file's latest, or abandoned. Both take whoever may manage the file
// (`canUserManageFile`), and neither is open to a bot by its person's place:
// that rule is the upload's alone.
//
// **Each names the version it means, and checks under the file row's lock
// that it is still the file's candidate.** A file has one candidate at a
// time, so "the candidate" would do for a single manager. With two it is a
// click that lands on a version another manager uploaded since, which the
// one who clicked never saw.

/** The version, with its file, and the actor's right to manage that file. */
async function requireManageableVersion(actor: Actor, versionId: string): Promise<{ fileId: string; slug: string; number: number; sha256: string }> {
  const version = await prisma.fileVersion.findUnique({ where: { id: versionId }, select: { fileId: true, number: true, sha256: true } });
  if (!version) throw new ApiError("not_found", "That version doesn't exist.");
  const { slug } = await requireManageable(actor, version.fileId);
  return { ...version, slug };
}

/** The version as it stands under the file row's lock, or a refusal where it is no longer the file's candidate, or the file is deleted. */
async function lockCandidate(tx: TransactionClient, versionId: string, fileId: string, doing: "promoted" | "abandoned"): Promise<{ currentVersionId: string | null }> {
  const file = await lockFileRow(tx, fileId);
  if (!file) throw new ApiError("not_found", "File not found.");
  if (file.deleted) throw new ApiError("conflict", `This file is deleted, and its waiting version can't be ${doing} until it is restored.`);
  const version = await tx.fileVersion.findUnique({ where: { id: versionId }, select: { number: true, promotedAt: true, abandonedAt: true } });
  if (!version || version.promotedAt !== null || version.abandonedAt !== null) {
    const now = !version ? "is gone" : version.abandonedAt !== null ? "was abandoned" : "is already promoted";
    throw new ApiError("conflict", `That version ${now}, so it is no longer this file's waiting version. Reload the page to see the file's versions as they are.`);
  }
  return file;
}

/**
 * Makes a candidate the file's latest version (docs/PDF.md §13, "Promotion"):
 * one transaction, the file row locked. Refused where the version is no
 * longer the file's candidate or the file is deleted, and by nothing else:
 * no note on the outgoing version holds it up.
 *
 * It moves no note. An anchor stays on the version it is on, where it is
 * still drawn, and every other version's page lists it under that version.
 * The file's id, slug, title, visibility, owners, tags and references are as
 * they were; only `/pdf/<slug>` shows other bytes.
 *
 * The lock is what a capture's check waits on: a capture holds the file row
 * `FOR SHARE` in the transaction that inserts its row
 * (`assertCaptureVersion`), so this update waits for it, and a capture that
 * starts after it sees the new latest and is refused.
 */
export async function promoteFileVersion(actor: Actor, versionId: string): Promise<{ slug: string; number: number }> {
  const version = await requireManageableVersion(actor, versionId);
  await prisma.$transaction(async (tx) => {
    await lockCandidate(tx, versionId, version.fileId, "promoted");
    const tail = await tx.ydocUpdate.aggregate({ _max: { id: true } });
    await tx.fileVersion.update({
      where: { id: versionId },
      data: { promotedAt: new Date(), promotedByUserId: actor.userId, promotedAtUpdateId: tail._max.id ?? BigInt(0) },
    });
    // Through Prisma, so `updatedAt` moves: the file's search vector is
    // refreshed by the trigger on `current_version_id`, which reads the new
    // latest's filename.
    await tx.storedFile.update({ where: { id: version.fileId }, data: { currentVersionId: versionId, updatedByUserId: actor.userId } });
  }, VERSION_WRITE_TIMEOUTS);
  return { slug: version.slug, number: version.number };
}

/**
 * Abandons a candidate (docs/PDF.md §13, "The upload"): marks its row, and
 * deletes its page text and its bytes, unless another row holds them. The
 * row keeps its number, which is never reused, its hash and its labels, and
 * its address answers with a page that says so.
 *
 * **The blob is removed before the transaction commits, under the lock on
 * its hash** (`lockFileHash`), which every upload takes in the transaction
 * that inserts its row. Removed after the commit, the blob could go from
 * under a row an upload of the same bytes has just written. A commit that
 * fails after the removal leaves a candidate without bytes, which
 * `check-file-versions.ts` reports and a second abandoning clears.
 */
export async function abandonFileVersion(actor: Actor, versionId: string): Promise<{ slug: string; number: number }> {
  const version = await requireManageableVersion(actor, versionId);
  await prisma.$transaction(async (tx) => {
    await lockCandidate(tx, versionId, version.fileId, "abandoned");
    await lockFileHash(tx, version.sha256);
    await tx.fileVersion.update({ where: { id: versionId }, data: { abandonedAt: new Date() } });
    await tx.filePageText.deleteMany({ where: { fileVersionId: versionId } });
    // Every other row holding these bytes: this one is abandoned now, and holds none.
    const others = await tx.fileVersion.count({ where: { sha256: version.sha256, abandonedAt: null } });
    await deleteBytesIfUnreferenced(version.sha256, others);
  }, VERSION_WRITE_TIMEOUTS);
  return { slug: version.slug, number: version.number };
}

// ---------------------------------------------------------------------------
// docs/PDF.md §13, "Matching the pages" — the two acts a manager makes about
// a version's page map. Each takes `canUserManageFile`, as promoting does,
// and neither is open to a bot by its person's place.

/**
 * Stores the page map between a version and its base, where the version has
 * none. **Storing a map says the two versions hold the same text.** It moves
 * no note. What it changes at once is where links land: a link that names one
 * of the two versions is carried to the other from then on, and no longer
 * opens the version it names. Asked for a version that has a map already, it
 * answers that map and writes nothing.
 */
export async function buildFileVersionMap(actor: Actor, versionId: string): Promise<{ slug: string; number: number; stored: boolean; numbers: PageMapNumbers }> {
  const version = await requireManageableVersion(actor, versionId);
  const { map, stored } = await storePageMap(versionId, { userId: actor.userId });
  return { slug: version.slug, number: version.number, stored, numbers: pageMapNumbers(map) };
}

/**
 * Answers one run of sheets of a version's page map: accepted, which pairs
 * its sheets as proposed and stays, or declined, which takes the question
 * off the list of open ones. Any manager may answer at any time, while the
 * version is a candidate and after its promotion. Accepting moves no note.
 */
export async function answerFileVersionMapRun(
  actor: Actor,
  versionId: string,
  runIndex: number,
  accepted: boolean,
): Promise<{ slug: string; number: number; numbers: PageMapNumbers }> {
  const version = await requireManageableVersion(actor, versionId);
  if (!Number.isInteger(runIndex) || runIndex < 0) throw invalid("That isn't one of this page map's questions.");
  const { map } = await storeRunAnswer(versionId, runIndex, accepted, { userId: actor.userId });
  return { slug: version.slug, number: version.number, numbers: pageMapNumbers(map) };
}
