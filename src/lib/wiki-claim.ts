import type { Prisma } from "@/generated/prisma/client";
import { HELD_COMMONS_NAMES } from "@/lib/wiki-address";
import { checkWikiName } from "@/lib/wiki-name";

// docs/WIKI.md "Claiming an address" and "Case" — the server half of a wiki
// address; wiki-address.ts is the pure half. What a claim asks the database
// about a name that comes in, from a URL or a dialog, is asked here, in one
// statement: its key, by the one SQL function that folds (`wiki_name_key`,
// migration wiki_pages), whether every code point in it is assigned, by the
// database's Unicode, which is the one the key is folded by, and whether it is
// one of the commons names held for editors. Nothing folds in TypeScript: no
// JavaScript function agrees with `casefold`.

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

/**
 * Folds a name the rules have already accepted (checkWikiName), on `db`, a
 * transaction's client when the answer guards a write in it.
 */
export async function foldWikiName(db: Pick<Prisma.TransactionClient, "$queryRaw">, name: string): Promise<FoldedWikiName> {
  const checked = checkWikiName(name);
  if (!checked.ok || checked.name !== name) {
    // A caller's fault, not a reader's: every name reaching here was normalized and checked first.
    throw new Error("foldWikiName takes a name checkWikiName has accepted, as it returned it.");
  }
  const held = [...HELD_COMMONS_NAMES];
  const rows = await db.$queryRaw<{ key: string; assigned: boolean; held: boolean }[]>`
    SELECT wiki_name_key(${name}) AS key,
           unicode_assigned(${name}) AS assigned,
           wiki_name_key(${name}) IN (SELECT wiki_name_key(h) FROM unnest(${held}::text[]) AS h) AS held`;
  const [row] = rows;
  return { key: row.key, assigned: row.assigned, heldInCommons: row.held };
}
