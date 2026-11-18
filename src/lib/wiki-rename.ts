import type { Prisma } from "@/generated/prisma/client";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid, notFound } from "@/lib/api/errors";
import { canUserReadDoc } from "@/lib/doc-authz";
import { lockDoc, type LockedDoc } from "@/lib/doc-manage";
import { REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";
import { wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import { claimWikiAddress, foldWikiName, lockWikiName, WikiAddressTaken } from "@/lib/wiki-claim";
import { requireWikiName, requireWikiVariant } from "@/lib/wiki-create";

// docs/WIKI.md "Renaming" — a wiki page renamed within its namespace, as
// functions taking an Actor, which the editor's name field and
// /doc/<slug>/slug's controls reach through server actions (CLAUDE.md, "A
// write the UI and the MCP server share is a function in src/lib/"). As the
// slug tables work (doc-slug.ts), but:
//
// - **the address a page leaves is reserved**: a wiki_address_history row
//   that holds it, so every claim refuses it and every default sequence
//   passes over it (wiki-claim.ts' takenVariants) until the row is deleted;
//   and it sends a reader on to the page (wiki-pages.ts' oldAddressTarget);
// - **the page's own history is the exception**: renaming back to an address
//   it had takes it, and deletes its own rows there, so a page's history
//   never names where it lives;
// - **a rename that changes only case keeps no row**: the fold finds the page
//   already, and the case redirect sends the old capitals on;
// - **the locks are taken in moving's and restoring's order**: the doc's row
//   first (lockDoc), the deleted page refused and the address it leaves read
//   under that lock, and only then the address locks of the name it leaves
//   and the name it takes, in key order;
// - **Doc.title follows in the rename's transaction**, named in the same
//   UPDATE as wiki_name, since the search vector's trigger fires by the
//   columns a statement names ("The name is the title").
//
// Moving between namespaces and out of the wiki (PR 5) releases rows rather
// than reserving them, and lives in wiki-move.ts.

/** Where a page lives after a rename or a revert, and the address it left (null when nothing changed, or only case). */
export type WikiRenameResult = { path: string; editPath: string; renamedFrom: string | null };

export type WikiRenameInput = {
  /** The name as typed; normalized and checked here. It is the page's title. */
  name: string;
  /** The variant as typed, "" for the page itself; left out, the page keeps its own. */
  variant?: string;
};

type Tx = Prisma.TransactionClient;

/**
 * lockDoc, then the rename rule: a live wiki page, and the actor able to edit
 * it, which within a namespace is who may rename (docs/WIKI.md "Who may
 * rename"): a person's page's byline, a commons page's byline plus ADMIN and
 * EDITOR. A viewer who can't read the page gets the answer for a missing one,
 * since a Forbidden would confirm that a page exists.
 */
async function lockRenamable(tx: Tx, actor: Actor, docId: string): Promise<LockedDoc & { wikiName: string }> {
  const doc = await lockDoc(tx, actor, docId);
  if (!doc) throw notFound("That page");
  if (!doc.canEdit) {
    const readable = await canUserReadDoc(actor.userId, actor.role, { id: docId, visibility: doc.visibility });
    if (doc.wikiName !== null && !readable) throw notFound("That page");
    throw forbidden("You don't have permission to rename this page.");
  }
  if (doc.wikiName === null) throw invalid("That doc isn't a wiki page, so it has a title rather than a name.");
  if (doc.deleted) throw invalid("A deleted page can't be renamed; restore it first.");
  return { ...doc, wikiName: doc.wikiName };
}

async function ownerOf(tx: Pick<Tx, "user">, ownerUserId: string | null): Promise<WikiOwner> {
  if (ownerUserId === null) return { kind: "commons" };
  const owner = await tx.user.findUnique({ where: { id: ownerUserId }, select: { slug: true } });
  if (!owner) throw new Error(`A wiki page's owner ${ownerUserId} has no row.`);
  return { kind: "person", slug: owner.slug };
}

/**
 * Moves a locked page from its address to `to` in its own namespace, under
 * the address locks of both names, taken in key order, and returns where it
 * now lives. `keepRow` says whether the address left is reserved; a rename
 * that changes only case keeps none whatever it says.
 */
async function moveWithinNamespace(
  tx: Tx,
  actor: Actor,
  docId: string,
  doc: LockedDoc & { wikiName: string },
  to: { name: string; variant: string },
  keepRow: boolean,
): Promise<WikiRenameResult> {
  const ownerUserId = doc.wikiOwnerUserId;
  const owner = await ownerOf(tx, ownerUserId);
  const fromPath = wikiPagePath({ owner, name: doc.wikiName, variant: doc.wikiVariant });
  if (to.name === doc.wikiName && to.variant === doc.wikiVariant) {
    return { path: fromPath, editPath: `${fromPath}/edit`, renamedFrom: null };
  }

  const [leaving, taking] = await Promise.all([foldWikiName(tx, doc.wikiName), foldWikiName(tx, to.name)]);
  const caseOnly = leaving.key === taking.key && to.variant === doc.wikiVariant;

  // The address locks in key order, so no two writes take the same two in
  // opposite orders. One name's variants share one lock; Postgres's advisory
  // locks are reentrant within a transaction, so the same key twice is one.
  const claimNew = async () => {
    if (caseOnly) {
      // The page holds this name already, held commons name or not: only its
      // capitals change, and nothing is claimed.
      await lockWikiName(tx, ownerUserId, to.name);
      return;
    }
    await claimWikiAddress(tx, actor.role, { ownerUserId, name: to.name, choice: { variant: to.variant } }, docId);
  };
  if (leaving.key <= taking.key) {
    await lockWikiName(tx, ownerUserId, doc.wikiName);
    await claimNew();
  } else {
    await claimNew();
    await lockWikiName(tx, ownerUserId, doc.wikiName);
  }

  if (!caseOnly) {
    // The page's own rows at either address go: at the one it takes, since
    // its history never names where it lives; at the one it leaves, so the
    // row written next is its only one there.
    await tx.wikiAddressHistory.deleteMany({
      where: {
        docId,
        ownerUserId,
        OR: [
          { nameKey: taking.key, variant: to.variant },
          { nameKey: leaving.key, variant: doc.wikiVariant },
        ],
      },
    });
    if (keepRow) {
      await tx.wikiAddressHistory.create({
        data: { docId, ownerUserId, name: doc.wikiName, variant: doc.wikiVariant, reserved: true, movedByUserId: actor.userId },
      });
    }
  }
  // title beside wiki_name: the mirror trigger would put the name there
  // anyway, but the search vector's fires only on the columns named.
  await tx.doc.update({
    where: { id: docId },
    data: { wikiName: to.name, title: to.name, wikiVariant: to.variant, updatedByUserId: actor.userId },
  });
  const path = wikiPagePath({ owner, name: to.name, variant: to.variant });
  return { path, editPath: `${path}/edit`, renamedFrom: fromPath };
}

/**
 * Renames a wiki page within its namespace: its name, its variant, or both.
 * The address it leaves is reserved, but on a change of case alone; a typed
 * address that is taken, by a live page or a reserved row not its own, is
 * refused, naming it; a held commons name is an ADMIN's or EDITOR's to give.
 */
export async function renameWikiPage(actor: Actor, docId: string, input: WikiRenameInput): Promise<WikiRenameResult> {
  const name = requireWikiName(input.name);
  const variant = input.variant === undefined ? undefined : requireWikiVariant(input.variant.trim());
  let ownerUserId: string | null = null;
  const target = { name, variant: variant ?? "" };
  try {
    return await prismaIncludingDeleted.$transaction(async (tx) => {
      const doc = await lockRenamable(tx, actor, docId);
      ownerUserId = doc.wikiOwnerUserId;
      target.variant = variant ?? doc.wikiVariant;
      return moveWithinNamespace(tx, actor, docId, doc, target, true);
    });
  } catch (err) {
    if (!(err instanceof WikiAddressTaken)) throw err;
    // Named, as /wiki/new names one: whoever may rename in a namespace may
    // read all of it, and the path sends them to the page holding it.
    const owner = await ownerOf(prismaIncludingDeleted, ownerUserId);
    throw new ApiError("conflict", "That address is taken.", { path: wikiPagePath({ owner, ...target }) });
  }
}

/**
 * Sends a page back to its most recent reserved address, the last rename
 * within its namespace, as revertDocSlug does a slug. The address it leaves
 * is reserved in turn, unless the page went live there within the hour
 * (REVERT_DISCARD_WINDOW_MS): undoing a rename made by mistake leaves no
 * trace of the mistake. A move between namespaces is undone by moving back.
 */
export async function revertWikiAddress(actor: Actor, docId: string): Promise<WikiRenameResult> {
  return prismaIncludingDeleted.$transaction(async (tx) => {
    const doc = await lockRenamable(tx, actor, docId);
    const last = await tx.wikiAddressHistory.findFirst({
      where: { docId, reserved: true },
      orderBy: { createdAt: "desc" },
      select: { name: true, variant: true },
    });
    if (!last) throw invalid("This page has no past address to go back to.");
    // When the page went live where it is: the newest row of any kind, since
    // a row is written as the page leaves an address for another.
    const newest = await tx.wikiAddressHistory.findFirst({ where: { docId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const keepRow = !newest || Date.now() - newest.createdAt.getTime() >= REVERT_DISCARD_WINDOW_MS;
    return moveWithinNamespace(tx, actor, docId, doc, { name: last.name, variant: last.variant }, keepRow);
  });
}

/**
 * Deletes one row of a page's address history, which ends its redirect and,
 * for a reserved row, frees its address. The page's editors may, as they may
 * delete a slug history row.
 */
export async function deleteWikiAddressRow(actor: Actor, docId: string, rowId: string): Promise<void> {
  await prismaIncludingDeleted.$transaction(async (tx) => {
    const doc = await lockDoc(tx, actor, docId);
    if (!doc) throw notFound("That doc");
    if (!doc.canEdit) {
      if (doc.wikiName !== null && !(await canUserReadDoc(actor.userId, actor.role, { id: docId, visibility: doc.visibility }))) {
        throw notFound("That doc");
      }
      throw forbidden("You don't have permission to change this doc's past addresses.");
    }
    const { count } = await tx.wikiAddressHistory.deleteMany({ where: { id: rowId, docId } });
    if (count === 0) throw new ApiError("not_found", "That past address is already gone.");
  });
}

/** One address a doc has left, as /doc/<slug>/slug and a delete's confirmation list it. */
export type WikiAddressHistoryEntry = {
  id: string;
  /** The address's path, as wikiPagePath spells it. */
  path: string;
  /** When the page left it, as an ISO string. */
  leftAt: string;
  /** Whether it holds the address (reserved), or only redirects when nothing else answers (released). */
  reserved: boolean;
  /** Who moved the page off it, null when their account has gone. */
  movedBy: string | null;
};

/**
 * The address histories of `docIds`, newest first, keyed by doc id; a doc
 * with none has no key. `nameOf` gives each mover's name as the surface shows
 * one. Asked of what the caller has already gated: the rows say where a page
 * was, which only those who may read it may learn.
 */
export async function wikiAddressHistoriesOf(
  docIds: readonly string[],
  nameOf: (user: { id: string; name: string | null; email: string }) => string,
): Promise<Map<string, WikiAddressHistoryEntry[]>> {
  const result = new Map<string, WikiAddressHistoryEntry[]>();
  if (docIds.length === 0) return result;
  const rows = await prismaIncludingDeleted.wikiAddressHistory.findMany({
    where: { docId: { in: [...docIds] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      docId: true,
      name: true,
      variant: true,
      reserved: true,
      createdAt: true,
      owner: { select: { slug: true } },
      movedBy: { select: { id: true, name: true, email: true } },
    },
  });
  for (const row of rows) {
    const owner: WikiOwner = row.owner ? { kind: "person", slug: row.owner.slug } : { kind: "commons" };
    const entry: WikiAddressHistoryEntry = {
      id: row.id,
      path: wikiPagePath({ owner, name: row.name, variant: row.variant }),
      leftAt: row.createdAt.toISOString(),
      reserved: row.reserved,
      movedBy: row.movedBy ? nameOf(row.movedBy) : null,
    };
    const list = result.get(row.docId);
    if (list) list.push(entry);
    else result.set(row.docId, [entry]);
  }
  return result;
}
