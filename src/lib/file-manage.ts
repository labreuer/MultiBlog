import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canUserManageFile } from "@/lib/file-authz";
import { changeFileSlug, freeFileSlugFor } from "@/lib/file-slug";
import { FILE_MANAGER_ROLES } from "@/lib/role-checks";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import type { DocVisibility } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/actor";

// Managing an uploaded file — its visibility, title, slug, owners and soft
// deletion — as plain functions taking an explicit actor, the file
// counterpart of src/lib/doc-manage.ts: /files' actions
// (src/app/actions/files.ts) wrap them with the session, and the MCP
// server's `manage` and `edit_file` with a token's user. Each refusal is an
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

/** A file's title, trimmed and capped. It keeps no history, which is why edit_file prompts. */
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
    throw new ApiError("conflict", err instanceof Error ? err.message : "That slug is in use.");
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
