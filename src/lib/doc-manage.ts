import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canUserEditDoc } from "@/lib/doc-authz";
import { changeDocSlug } from "@/lib/doc-slug";
import { BYLINE_ELIGIBLE_ROLES } from "@/lib/role-checks";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import type { DocVisibility } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/actor";

// Managing a doc — its byline, visibility, slug, record flag, and soft
// deletion — as plain functions taking an explicit actor (docs/MCP.md §1):
// /doc/[slug]/edit's and /docs' actions (src/app/actions/docs.ts) wrap them
// with the session, and the MCP server's `manage` tool with a token's user.
// Each refusal is an ApiError, whose message reads the same in either front
// door.
//
// Every write here that moves Doc.updatedAt also names who moved it
// (Doc.updatedByUserId): updatedAt is @updatedAt, so leaving updatedBy out
// would let "Updated" advance while "Updated by" still credited an older edit.

async function requireEditable(actor: Actor, docId: string, opts: { includeDeleted?: boolean } = {}): Promise<void> {
  const exists = opts.includeDeleted
    ? await prismaIncludingDeleted.doc.findUnique({ where: { id: docId }, select: { id: true } })
    : await prisma.doc.findUnique({ where: { id: docId }, select: { id: true } });
  if (!exists) throw new ApiError("not_found", "Doc not found.");
  if (!(await canUserEditDoc(actor.userId, actor.role, docId, opts))) {
    throw forbidden("You don't have permission to edit this doc.");
  }
}

/**
 * A doc's byline, as the ordered list `orderedUserIds`: the one function
 * every byline change goes through (docs/MCP.md §12). Its rules:
 *
 * - the actor can edit the doc;
 * - everyone it adds is a live account in `BYLINE_ELIGIBLE_ROLES` — the edit
 *   page's picker offers only those, but the actions behind it took any id.
 *   Someone already on it stays eligible to stay, so a byline holding a
 *   since-demoted or deleted account can still be reordered;
 * - at least one author remains;
 * - **removing someone takes `allowRemovals`**: on a PRIVATE doc the byline
 *   is the access list, so a removal revokes their access, the actor's own
 *   included, and a caller has to mean it;
 * - the change is one transaction, and sets `updatedByUserId`.
 */
export async function setDocByline(
  actor: Actor,
  docId: string,
  orderedUserIds: readonly string[],
  opts: { allowRemovals?: boolean } = {},
): Promise<void> {
  await requireEditable(actor, docId);
  const wanted = [...new Set(orderedUserIds)];
  if (wanted.length === 0) throw invalid("A doc must have at least one author.");
  if (wanted.length !== orderedUserIds.length) throw invalid("A byline names each person once.");

  await prisma.$transaction(async (tx) => {
    const current = new Set((await tx.docAuthor.findMany({ where: { docId }, select: { userId: true } })).map((a) => a.userId));
    const added = wanted.filter((id) => !current.has(id));
    const users = await tx.user.findMany({ where: { id: { in: added } }, select: { id: true, role: true } });
    const eligible = new Set(users.filter((u) => BYLINE_ELIGIBLE_ROLES.includes(u.role)).map((u) => u.id));
    const ineligible = added.filter((id) => !eligible.has(id));
    if (ineligible.length > 0) {
      throw invalid("Only an admin, editor or author account can be added to a byline.", { userIds: ineligible.slice(0, 5) });
    }
    const removed = [...current].filter((id) => !wanted.includes(id));
    if (removed.length > 0 && !opts.allowRemovals) {
      throw invalid("That byline leaves someone off it, which on a PRIVATE doc takes their access away; pass allowRemovals to mean it.", {
        removing: removed,
      });
    }
    if (removed.length > 0) await tx.docAuthor.deleteMany({ where: { docId, userId: { in: removed } } });
    for (const [bylineOrder, userId] of wanted.entries()) {
      await tx.docAuthor.upsert({
        where: { docId_userId: { docId, userId } },
        create: { docId, userId, bylineOrder },
        update: { bylineOrder },
      });
    }
    await tx.doc.update({ where: { id: docId }, data: { updatedByUserId: actor.userId } });
  });
}

/** The doc's byline, in order. */
export async function docBylineIds(docId: string): Promise<string[]> {
  const authors = await prisma.docAuthor.findMany({ where: { docId }, orderBy: { bylineOrder: "asc" }, select: { userId: true } });
  return authors.map((a) => a.userId);
}

export async function setDocVisibility(actor: Actor, docId: string, visibility: DocVisibility): Promise<void> {
  await requireEditable(actor, docId);
  if (visibility !== "PRIVATE" && visibility !== "SHARED") throw invalid("Invalid visibility.");
  await prisma.doc.update({ where: { id: docId }, data: { visibility, updatedByUserId: actor.userId } });
}

/** Renames a doc's slug, the old one kept in its history; returns the slug it now has. */
export async function setDocSlug(actor: Actor, docId: string, slug: string): Promise<string> {
  await requireEditable(actor, docId);
  try {
    return await changeDocSlug(docId, slug, actor.userId);
  } catch (err) {
    throw new ApiError("conflict", err instanceof Error ? err.message : "That slug is in use.");
  }
}

/**
 * Whether a doc is a record (docs/MCP.md §6): an imported chat, evidence of
 * what was said, which edit_doc refuses. Marking or unmarking one is the
 * `manage` scope; the editor doesn't consult the flag.
 */
export async function setDocRecord(actor: Actor, docId: string, record: boolean): Promise<void> {
  await requireEditable(actor, docId);
  await prisma.doc.update({ where: { id: docId }, data: { record, updatedByUserId: actor.userId } });
}

/**
 * Soft delete or restore — each other's undo. Restoring is a question about
 * a deleted row, so it reads through prismaIncludingDeleted. Never a hard
 * delete: that cascades away every anchor into the doc
 * (docs/CLAUDE_IMPORT.md §6).
 */
export async function setDocDeleted(actor: Actor, docId: string, deleted: boolean): Promise<void> {
  await requireEditable(actor, docId, { includeDeleted: true });
  await prisma.doc.update({
    where: { id: docId },
    data: deleted
      ? { deletedByUserId: actor.userId, deletedAt: new Date(), updatedByUserId: actor.userId }
      : { deletedByUserId: null, deletedAt: null, updatedByUserId: actor.userId },
  });
}
