import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { canMakePagesPublic, canManageDocs } from "@/lib/role-checks";
import { forbidden, invalid } from "@/lib/api/errors";
import { firstFreeVariant, HELD_COMMONS_NAMES, type VariantDefaults } from "@/lib/wiki-address";
import { checkWikiName } from "@/lib/wiki-name";

// docs/WIKI.md "Claiming an address" and "Case" — the server half of a wiki
// address; wiki-address.ts is the pure half. What a claim asks the database
// about a name that comes in, from a URL or a dialog, is asked here, in one
// statement: its key, by the one SQL function that folds (`wiki_name_key`,
// migration wiki_pages), whether every code point in it is assigned, by the
// database's Unicode, which is the one the key is folded by, and whether it is
// one of the commons names held for editors. Nothing folds in TypeScript: no
// JavaScript function agrees with `casefold`.
//
// A claim (creating, forking, moving, renaming, restoring) also takes the
// address lock in that statement, and then picks or checks the variant under
// it, in the transaction that writes the doc. And two fresh reads of an
// account are here, since a session may be behind its account by the interval
// it re-reads at (src/app/sign-in/NOTES.md): `ownerWhoCanAct`, of a person's
// namespace's owner, which raising, deleting, restoring and claiming there
// each ask, and `requireCanMakePublic`, of whoever would make a page PUBLIC.

/** What the database says of a name: its key, and whether it may be claimed at all and by whom. */
export type FoldedWikiName = {
  /** `wiki_name_key(name)`, which the unique indexes compare. */
  key: string;
  /** Whether every code point is one the database's Unicode has assigned (`unicode_assigned`); a name with one that isn't is refused. */
  assigned: boolean;
  /** Whether the key is a HELD_COMMONS_NAMES name's, which in the commons only an ADMIN or EDITOR claims. */
  heldInCommons: boolean;
};

/** The message a name with an unassigned code point is refused with, in place of the raw CHECK error. */
export const UNASSIGNED_NAME_MESSAGE = "A name can't hold a character this server's Unicode doesn't know yet.";

/** The message a claim of a held commons name is refused with. */
export const HELD_NAME_MESSAGE = "That name is kept for editors in the commons: only an ADMIN or EDITOR can give a page it.";

type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

function requireCheckedName(name: string): void {
  const checked = checkWikiName(name);
  if (!checked.ok || checked.name !== name) {
    // A caller's fault, not a reader's: every name reaching here was normalized and checked first.
    throw new Error("A wiki name reaching the database must be one checkWikiName has accepted, as it returned it.");
  }
}

/**
 * Folds a name the rules have already accepted (checkWikiName), on `db`, a
 * transaction's client when the answer guards a write in it.
 */
export async function foldWikiName(db: RawClient, name: string): Promise<FoldedWikiName> {
  requireCheckedName(name);
  const held = [...HELD_COMMONS_NAMES];
  const rows = await db.$queryRaw<{ key: string; assigned: boolean; held: boolean }[]>`
    SELECT wiki_name_key(${name}) AS key,
           unicode_assigned(${name}) AS assigned,
           wiki_name_key(${name}) IN (SELECT wiki_name_key(h) FROM unnest(${held}::text[]) AS h) AS held`;
  const [row] = rows;
  return { key: row.key, assigned: row.assigned, heldInCommons: row.held };
}

/** "wiki" as four ASCII bytes: the first key of the two-key advisory lock, a space of the wiki's own (the file slugs' is "file"). */
const WIKI_ADDRESS_LOCK_SPACE = 0x77696b69;

/**
 * foldWikiName, taking the address lock in the same statement: the lock on
 * every variant of `name` in one namespace, for the rest of `tx`. Two claims
 * of one name then queue rather than race, and the partial unique indexes
 * stay the backstop. All the variants of a name share the lock, since a
 * default is picked by reading them all; `Apple` and `apple` share it, since
 * the key is folded.
 *
 * The owner half of the key is built here, as the owner's id or `commons`:
 * built in SQL from the owner column, a commons page's null owner would make
 * the key null, and `hashtext` and `pg_advisory_xact_lock` are both STRICT,
 * so the call would lock nothing.
 */
export async function lockWikiName(tx: RawClient, ownerUserId: string | null, name: string): Promise<FoldedWikiName> {
  requireCheckedName(name);
  const owner = ownerUserId ?? "commons";
  const held = [...HELD_COMMONS_NAMES];
  const rows = await tx.$queryRaw<{ key: string; assigned: boolean; held: boolean }[]>`
    SELECT wiki_name_key(${name}) AS key,
           unicode_assigned(${name}) AS assigned,
           wiki_name_key(${name}) IN (SELECT wiki_name_key(h) FROM unnest(${held}::text[]) AS h) AS held,
           pg_advisory_xact_lock(${WIKI_ADDRESS_LOCK_SPACE}::int4, hashtext(${owner} || '/' || wiki_name_key(${name}))) IS NULL AS locked`;
  const [row] = rows;
  return { key: row.key, assigned: row.assigned, heldInCommons: row.held };
}

/**
 * The variants held at a name's key in one namespace, asked under
 * lockWikiName: those a live page lives at, and those a reserved history row
 * holds (docs/WIKI.md "Renaming"). A released row holds nothing. The
 * claiming doc's own address and own rows don't count against it
 * (`excludeDocId`): a page renamed back to an address it had takes it.
 */
export async function takenVariants(
  tx: Prisma.TransactionClient,
  ownerUserId: string | null,
  key: string,
  excludeDocId?: string,
): Promise<Set<string>> {
  const notThisDoc = excludeDocId ? { id: { not: excludeDocId } } : {};
  const notThisDocsRows = excludeDocId ? { docId: { not: excludeDocId } } : {};
  const [live, reserved] = await Promise.all([
    tx.doc.findMany({
      where: { wikiNameKey: key, wikiName: { not: null }, wikiOwnerUserId: ownerUserId, deletedByUserId: null, ...notThisDoc },
      select: { wikiVariant: true },
    }),
    tx.wikiAddressHistory.findMany({
      where: { nameKey: key, ownerUserId, reserved: true, ...notThisDocsRows },
      select: { variant: true },
    }),
  ]);
  return new Set([...live.map((row) => row.wikiVariant), ...reserved.map((row) => row.variant)]);
}

/** A claim of a typed address that a live page or a reserved history row already holds, refused before anything is written. */
export class WikiAddressTaken extends Error {
  constructor() {
    super("That address is taken.");
    this.name = "WikiAddressTaken";
  }
}

/** What a claim is asked for: the namespace, the name, and a typed variant or the sequence to pick one from. */
export type WikiClaim = {
  ownerUserId: string | null;
  name: string;
  choice: { variant: string } | { defaults: VariantDefaults };
};

/**
 * Claims an address under its lock, in `tx`, the transaction that then writes
 * the doc (docs/WIKI.md "Claiming an address"):
 *
 * - the lock, the key, `unicode_assigned` and the held names in one statement
 *   (lockWikiName); a name with an unassigned code point is refused with a
 *   message rather than the raw CHECK error;
 * - **a held commons name needs an ADMIN or EDITOR** (`actorRole`), whatever
 *   the variant, so creating, forking, moving in, renaming and restoring all
 *   meet it and none can be added without it;
 * - a typed variant is taken as typed, or refused as taken
 *   (WikiAddressTaken); with none, the server walks the default sequence and
 *   takes the first free one, so of two claims of one default address the
 *   second gets the next. A dialog shows the default and sends none.
 *
 * `excludeDocId` is the doc making the claim, whose own address and history
 * rows don't count against it (a restore, a rename).
 */
export async function claimWikiAddress(
  tx: Prisma.TransactionClient,
  actorRole: Role,
  claim: WikiClaim,
  excludeDocId?: string,
): Promise<{ variant: string; key: string }> {
  const folded = await lockWikiName(tx, claim.ownerUserId, claim.name);
  if (!folded.assigned) throw invalid(UNASSIGNED_NAME_MESSAGE);
  if (claim.ownerUserId === null && folded.heldInCommons && actorRole !== "ADMIN" && actorRole !== "EDITOR") {
    throw forbidden(HELD_NAME_MESSAGE);
  }
  const taken = await takenVariants(tx, claim.ownerUserId, folded.key, excludeDocId);
  if ("variant" in claim.choice) {
    if (taken.has(claim.choice.variant)) throw new WikiAddressTaken();
    return { variant: claim.choice.variant, key: folded.key };
  }
  return { variant: firstFreeVariant(claim.choice.defaults, taken), key: folded.key };
}

export type WikiOwnerRow = { id: string; slug: string; email: string; name: string | null };

/**
 * A person's namespace's owner as their account is now, or null when they
 * can't act: a live account, through the filtered `prisma`, holding
 * `canManageDocs`, and a person rather than a bot (`worksForUserId` null:
 * docs/WIKI.md "A bot has no namespace"). The session's role isn't enough. A
 * browser session is a JWT that reads its account again only every five
 * minutes (src/app/sign-in/NOTES.md), so until it does, a deleted or demoted
 * owner could otherwise keep raising, deleting and claiming. Reading the row
 * here is what makes an ADMIN's demotion hold at once, whatever the owner's
 * session says.
 *
 * `db` is a transaction's client when the answer guards a write in it; the
 * filtered client's soft-delete rule is then spelled out.
 */
export async function ownerWhoCanAct(
  ownerUserId: string,
  db?: Pick<Prisma.TransactionClient, "user">,
): Promise<WikiOwnerRow | null> {
  const args = {
    where: { id: ownerUserId, deletedByUserId: null },
    select: { id: true, slug: true, email: true, name: true, role: true, worksForUserId: true },
  } satisfies Prisma.UserFindFirstArgs;
  const owner = db ? await db.user.findFirst(args) : await prisma.user.findFirst(args);
  if (!owner || !canManageDocs(owner.role) || owner.worksForUserId !== null) return null;
  return { id: owner.id, slug: owner.slug, email: owner.email, name: owner.name };
}

/** What a raise to PUBLIC is refused with, for an actor who isn't an ADMIN or EDITOR. */
export const PUBLIC_EDITORS_ONLY = "Only an ADMIN or EDITOR can make a page PUBLIC.";

/**
 * Refuses unless `actor` may make a page PUBLIC (docs/WIKI.md "Permissions"):
 * `canMakePagesPublic` of the role the caller acts with, and of the role
 * their row holds now, on a live account. Every writer that can raise
 * something to PUBLIC asks it: setDocVisibility, creating a page, forking
 * into the wiki, and a move that takes a PRIVATE doc or page into the
 * commons. A page that keeps PUBLIC through a move or a restore is not a
 * raise, and asks nothing.
 *
 * The row is read because a session may still hold a role its account has
 * lost, as ownerWhoCanAct's is: without it, a demoted EDITOR could go on
 * making pages public until their session next reads its account. Both are
 * asked, so a session that hasn't caught up with a promotion is refused as
 * its select, which offered no PUBLIC, would have it.
 *
 * `db` is a transaction's client when the answer guards a write in it; the
 * filtered client's soft-delete rule is then spelled out.
 */
export async function requireCanMakePublic(actor: Actor, db?: Pick<Prisma.TransactionClient, "user">): Promise<void> {
  if (canMakePagesPublic(actor.role)) {
    const args = {
      where: { id: actor.userId, deletedByUserId: null },
      select: { role: true },
    } satisfies Prisma.UserFindFirstArgs;
    const row = db ? await db.user.findFirst(args) : await prisma.user.findFirst(args);
    if (row && canMakePagesPublic(row.role)) return;
  }
  throw forbidden(PUBLIC_EDITORS_ONLY);
}
