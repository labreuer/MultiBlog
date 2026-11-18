import type { DocVisibility } from "@/generated/prisma/enums";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { canManageDocs, canUserReadDoc, canUserSeeDocHistory } from "@/lib/doc-authz";
import { createDocWithContent } from "@/lib/doc-create";
import { isDocVersion, loadDocStateAt, loadDocStateNow, type DocState } from "@/lib/doc-state";
import { parseUpdateId } from "@/lib/diff-side";
import { forkSeed } from "@/lib/fork-seed";
import type { WikiOwner } from "@/lib/wiki-address";

// docs/FORKS.md "Forks" — a new doc seeded from another doc's text at one
// version, which records the doc and the version it came from. A function
// taking an Actor, which the doc view's Fork action wraps (src/app/actions/
// docs.ts). A doc has at most one parent and lineage comes only from here, so
// there are no merges and no cycles, and "what the fork changed" can count on
// the fork having begun as that exact copy.
//
// Cut in three so that a caller forking into somewhere else reuses the first
// two: `readForkSource` (the checks, then the read), `forkSeed` (pure,
// src/lib/fork-seed.ts) and `forkDoc`.

export type ForkRequest = {
  parentId: string;
  /** The version the reader is looking at on the parent's scrub bar, as text; null for the doc as it is now. */
  revision: string | null;
  visibility: DocVisibility;
};

/**
 * The parent as the checks read it. `wikiName` is the parent's name when it
 * is a wiki page, else null: the fork's title then (docs/WIKI.md "Forking
 * into the wiki"). `wikiOwner` is its namespace, which a fork into the wiki
 * reads for the variant a `PUBLIC` parent lends.
 */
export type ForkParent = {
  id: string;
  visibility: DocVisibility;
  wikiName: string | null;
  wikiOwner: WikiOwner | null;
};

export type ForkSource = {
  parent: ForkParent;
  state: Omit<DocState, "version">;
  /** The parent's update the state is at, which becomes the fork point. */
  version: bigint;
};

/**
 * Steps 1 to 3 of readForkSource below, for a parent with no version: who may
 * fork, then whether the parent is there and readable, answered as the fork
 * would answer them. The Fork dialog's address preview asks these alone, so it
 * says what the fork would before saying anything about an address, and
 * reads no text.
 */
export async function checkForkParent(actor: Actor, parentId: string): Promise<ForkParent> {
  if (typeof parentId !== "string") throw invalid("That isn't a doc and a version.");
  if (!canManageDocs(actor.role)) throw forbidden("You don't have permission to create docs.");

  const parent = await prismaIncludingDeleted.doc.findUnique({
    where: { id: parentId },
    select: { id: true, visibility: true, deletedByUserId: true, wikiName: true, wikiOwner: { select: { slug: true } } },
  });
  if (!parent || parent.deletedByUserId !== null) throw new ApiError("not_found", "That doc doesn't exist.");
  if (!(await canUserReadDoc(actor.userId, actor.role, parent))) {
    // An unreadable wiki page is not found, as it is wherever a wiki doc is
    // looked up (docs/WIKI.md "Forking into the wiki"): a Forbidden would
    // confirm that a page exists.
    if (parent.wikiName !== null) throw new ApiError("not_found", "That doc doesn't exist.");
    throw forbidden("You don't have permission to read that doc.");
  }
  const wikiOwner: WikiOwner | null =
    parent.wikiName === null ? null : parent.wikiOwner ? { kind: "person", slug: parent.wikiOwner.slug } : { kind: "commons" };
  return { id: parent.id, visibility: parent.visibility, wikiName: parent.wikiName, wikiOwner };
}

/**
 * The parent as a fork copies it, for an actor who may fork it. In order:
 *
 * 1. `parentId` is a string and `revision` a string or null: a server action
 *    is sent whatever its caller likes, whatever a parameter's type says;
 * 2. the actor may create docs (`canManageDocs`), **before the parent is
 *    looked up**, so one who may not is told that and nothing about the
 *    parent;
 * 3. a parent that is missing or deleted is not found, deletion checked by
 *    hand since canUserReadDoc doesn't consider it, and one the actor can't
 *    read is Forbidden: the two answers the doc's own page gives. To an
 *    actor who has got this far the difference is useful, since Forbidden
 *    says the doc is there and to ask its authors. An unreadable wiki page
 *    is not found, as its address answers;
 * 4. a version needs the parent's history (`canUserSeeDocHistory`) and
 *    **then** `isDocVersion`, in that order, as a diff asks them: otherwise
 *    the fork would copy out text from a history its forker may never have
 *    been shown, and the answer would say which ids are in the log.
 *    `loadDocStateAt` replays up to any id without asking whether it is this
 *    doc's, so an unchecked one would record a fork point that isn't the
 *    parent's version;
 * 5. the read: `loadDocStateAt` for a version, `loadDocStateNow` for none,
 *    which is what a diff's side with no version reads, so a fork point is
 *    never ahead of a later diff's "now". A parent with no log has no
 *    version to record, and is refused.
 *
 * The fork-point exception (`canUserSeeDocVersion`) is for diffs alone:
 * forking a parent at a version stays its editors'.
 */
export async function readForkSource(actor: Actor, parentId: string, revision: string | null): Promise<ForkSource> {
  if (revision !== null && typeof revision !== "string") throw invalid("That isn't a doc and a version.");
  const parent = await checkForkParent(actor, parentId);

  if (revision !== null) {
    if (!(await canUserSeeDocHistory(actor.userId, actor.role, parent.id))) {
      throw forbidden("A doc's earlier versions are its editors'; fork it as it is now.");
    }
    const at = parseUpdateId(revision);
    if (at === null || !(await isDocVersion(parent.id, at))) throw invalid("That version isn't in this doc's history.");
    return { parent, state: await loadDocStateAt(parent.id, at), version: at };
  }

  const now = await loadDocStateNow(parent.id);
  if (now.version === null) throw invalid("That doc has no history yet, so there is no version to fork it at.");
  return { parent, state: now, version: now.version };
}

/**
 * Forks a doc: the forker's own doc, seeded with the parent's body, title and
 * chip styles at the version (`forkSeed`), on the forker's byline alone, with
 * the visibility asked for, whatever the parent's.
 *
 * **A wiki page's fork is titled with the page's name**, not the seed's: a
 * wiki page's title fragment is not its title (docs/WIKI.md "The name is the
 * title"), and may hold an earlier name, or the title the doc had before it
 * was moved in. A fork at an earlier version takes the current name too, as
 * the scrub bar shows it there.
 *
 * **The visibility is checked by name, before anything is read**, as
 * setDocVisibility checks it, and never by membership of `DocVisibility`: a
 * value added to that enum later would have a rule of its own for who may
 * choose it, which a membership test would let a fork walk past.
 *
 * Nothing is written to the parent: no snapshot at the fork point. What
 * stays with it: its annotations, tags, anchored links, doc links and posts,
 * and `record`, `importKey` and `importedUpdateId`, since a fork is for
 * changing and an importer must never match its source to the copy.
 */
export async function forkDoc(actor: Actor, request: ForkRequest): Promise<{ id: string; path: string }> {
  const visibility: unknown = request.visibility;
  if (visibility !== "PRIVATE" && visibility !== "SHARED") throw invalid("Invalid visibility.");

  const { parent, state, version } = await readForkSource(actor, request.parentId, request.revision);
  const seed = forkSeed(state);
  const created = await createDocWithContent(actor.userId, parent.wikiName ?? seed.title, seed.body, {
    visibility,
    forkedFrom: { docId: parent.id, updateId: version },
    chipStyles: seed.chipStyles,
  });
  return { id: created.id, path: `/doc/${created.slug}/edit` };
}
