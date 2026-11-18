import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canEditDocRow } from "@/lib/doc-authz";
import { changeDocSlugIn } from "@/lib/doc-slug";
import { BYLINE_ELIGIBLE_ROLES } from "@/lib/role-checks";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { allowedVisibilities } from "@/lib/doc-visibility";
import type { DocVisibility } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
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
//
// **Each function locks the doc's row first** (lockDoc), in its transaction,
// and only then asks canEditDocRow and its own rules, which read the address
// columns under the lock (docs/WIKI.md "Permissions"). Moving a doc into the
// wiki takes the same lock, so a change authorised under the rules from before
// a move can't land after it: an EDITOR's SHARED bypass adding them to the
// byline of what has just become someone's page.

/** A doc's row as its rules read it, under its lock. */
export type LockedDoc = {
  visibility: DocVisibility;
  wikiName: string | null;
  wikiVariant: string;
  wikiOwnerUserId: string | null;
  deleted: boolean;
  /** Whether the actor is on the byline, read under the lock. */
  isAuthor: boolean;
  /** canEditDocRow's answer for the actor, from what was read under the lock. */
  canEdit: boolean;
};

/**
 * Locks a doc's row `FOR UPDATE` for the rest of `tx`, as its first
 * statement, and reads what the rules on its settings ask; null when there is
 * no such doc, deleted or not. The read is raw, so a deleted doc is found and
 * says so (`deleted`), for a restore to act on and every other change to
 * refuse.
 */
export async function lockDoc(tx: Prisma.TransactionClient, actor: Actor, docId: string): Promise<LockedDoc | null> {
  const rows = await tx.$queryRaw<
    { visibility: DocVisibility; wiki_name: string | null; wiki_variant: string; wiki_owner_user_id: string | null; deleted: boolean }[]
  >`SELECT visibility::text AS visibility, wiki_name, wiki_variant, wiki_owner_user_id,
           deleted_by_user_id IS NOT NULL AS deleted
      FROM doc WHERE id = ${docId} FOR UPDATE`;
  if (rows.length === 0) return null;
  const [row] = rows;
  const author = await tx.docAuthor.findUnique({
    where: { docId_userId: { docId, userId: actor.userId } },
    select: { userId: true },
  });
  const doc = {
    visibility: row.visibility,
    wikiName: row.wiki_name,
    wikiVariant: row.wiki_variant,
    wikiOwnerUserId: row.wiki_owner_user_id,
    deleted: row.deleted,
  };
  const isAuthor = author !== null;
  return { ...doc, isAuthor, canEdit: canEditDocRow({ ...doc, isAuthor }, actor.role) };
}

/** lockDoc, then the edit rule: the doc, live (or deleted, with `includeDeleted`), and the actor able to edit it. */
async function lockEditable(
  tx: Prisma.TransactionClient,
  actor: Actor,
  docId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<LockedDoc> {
  const doc = await lockDoc(tx, actor, docId);
  if (!doc || (doc.deleted && !opts.includeDeleted)) throw new ApiError("not_found", "Doc not found.");
  if (!doc.canEdit) throw forbidden("You don't have permission to edit this doc.");
  return doc;
}

/**
 * A doc's byline, as the ordered list `orderedUserIds`: the one function
 * every byline change goes through (docs/MCP.md §12). Its rules:
 *
 * - the actor can edit the doc;
 * - everyone it adds is a live account in `BYLINE_ELIGIBLE_ROLES`, the ones
 *   the edit page's picker offers, whatever id a request sends. Someone
 *   already on it stays eligible to stay, so a byline holding a
 *   since-demoted or deleted account can still be reordered;
 * - at least one author remains;
 * - **removing someone takes `allowRemovals`**: on a PRIVATE doc the byline
 *   is the access list, so a removal revokes their access, the actor's own
 *   included, and a caller has to mean it;
 * - with `expected`, the byline the caller worked its list out from, the
 *   change is refused if the byline is no longer that. The edit page's add,
 *   remove and reorder pass it, so of two people editing one byline the
 *   second is told to retry rather than quietly undoing the first: a
 *   reorder would otherwise put back someone just removed, which on a
 *   PRIVATE doc gives back their access;
 * - the change is one transaction, holding the doc's row (lockDoc) so two
 *   byline changes can't interleave, and sets `updatedByUserId`. The rules
 *   above are checked under that lock.
 */
export async function setDocByline(
  actor: Actor,
  docId: string,
  orderedUserIds: readonly string[],
  opts: { allowRemovals?: boolean; expected?: readonly string[] } = {},
): Promise<void> {
  const wanted = [...new Set(orderedUserIds)];
  if (wanted.length === 0) throw invalid("A doc must have at least one author.");
  if (wanted.length !== orderedUserIds.length) throw invalid("A byline names each person once.");

  await prismaIncludingDeleted.$transaction(async (tx) => {
    await lockEditable(tx, actor, docId);
    const byline = (
      await tx.docAuthor.findMany({ where: { docId }, orderBy: { bylineOrder: "asc" }, select: { userId: true } })
    ).map((a) => a.userId);
    const { expected } = opts;
    if (expected && (expected.length !== byline.length || expected.some((id, i) => id !== byline[i]))) {
      throw new ApiError("conflict", "Author list changed — please retry.");
    }
    const current = new Set(byline);
    const added = wanted.filter((id) => !current.has(id));
    // A live account: the transaction's client is the unfiltered one, so the
    // soft-delete filter is spelled out.
    const users = await tx.user.findMany({
      where: { id: { in: added }, deletedByUserId: null },
      select: { id: true, role: true },
    });
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

/**
 * A doc's visibility, checked under the doc's row lock: a value
 * `allowedVisibilities` offers this actor, so what a select offers and what is
 * accepted can't differ. PUBLIC only on a wiki page, and never PRIVATE on a
 * commons page (docs/WIKI.md "Permissions").
 */
export async function setDocVisibility(actor: Actor, docId: string, visibility: DocVisibility): Promise<void> {
  await prismaIncludingDeleted.$transaction(async (tx) => {
    const doc = await lockEditable(tx, actor, docId);
    if (!allowedVisibilities(doc, actor.userId).includes(visibility)) {
      throw invalid(`This doc can't be made ${String(visibility)}.`);
    }
    await tx.doc.update({ where: { id: docId }, data: { visibility, updatedByUserId: actor.userId } });
  });
}

/** Renames a doc's slug, the old one kept in its history; returns the slug it now has. */
export async function setDocSlug(actor: Actor, docId: string, slug: string): Promise<string> {
  try {
    return await prismaIncludingDeleted.$transaction(async (tx) => {
      await lockEditable(tx, actor, docId);
      return changeDocSlugIn(tx, docId, slug, actor.userId);
    });
  } catch (err) {
    // changeDocSlug's own refusals (taken, gone) are plain Errors written
    // for the reader. Anything else, a Prisma rejection included, is a
    // fault, and its message is no answer to give.
    if (err instanceof Error && err.name === "Error") throw new ApiError("conflict", err.message);
    throw err;
  }
}

/**
 * Whether a doc is a record (docs/MCP.md §6): an imported chat, evidence of
 * what was said, which edit_doc refuses. Marking or unmarking one is the
 * `manage` scope; the editor doesn't consult the flag.
 */
export async function setDocRecord(actor: Actor, docId: string, record: boolean): Promise<void> {
  await prismaIncludingDeleted.$transaction(async (tx) => {
    await lockEditable(tx, actor, docId);
    await tx.doc.update({ where: { id: docId }, data: { record, updatedByUserId: actor.userId } });
  });
}

/**
 * Soft delete or restore — each other's undo. Restoring is a question about
 * a deleted row, so it reads through prismaIncludingDeleted. Never a hard
 * delete: that cascades away every anchor into the doc
 * (docs/CLAUDE_IMPORT.md §6).
 */
export async function setDocDeleted(actor: Actor, docId: string, deleted: boolean): Promise<void> {
  await prismaIncludingDeleted.$transaction(async (tx) => {
    await lockEditable(tx, actor, docId, { includeDeleted: true });
    await tx.doc.update({
      where: { id: docId },
      data: deleted
        ? { deletedByUserId: actor.userId, deletedAt: new Date(), updatedByUserId: actor.userId }
        : { deletedByUserId: null, deletedAt: null, updatedByUserId: actor.userId },
    });
  });
}
