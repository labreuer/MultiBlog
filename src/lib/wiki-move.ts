import type { Prisma } from "@/generated/prisma/client";
import type { DocVisibility } from "@/generated/prisma/enums";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid, notFound } from "@/lib/api/errors";
import { canEditAnySharedDoc, canUserReadDoc } from "@/lib/doc-authz";
import { requestDocEdit } from "@/lib/doc-edit-client";
import { lockDoc, type LockedDoc } from "@/lib/doc-manage";
import { NO_CHIP_INPUTS } from "@/lib/entity-chips/types";
import { wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import {
  claimWikiAddress,
  foldWikiName,
  lockWikiName,
  ownerWhoCanAct,
  requireCanMakePublic,
  WikiAddressTaken,
} from "@/lib/wiki-claim";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { claimableNamespace, requireWikiName, requireWikiVariant, type WikiNamespaceChoice } from "@/lib/wiki-create";
import { previewAddress, previewOrRefusal, type WikiAddressPreview } from "@/lib/wiki-fork";

// docs/WIKI.md "Moving a doc into the wiki" and "Moving out of the wiki" —
// giving an existing doc an address, in place, and taking a page to another
// namespace or out of the wiki, as functions taking an Actor, which the doc
// view's "Move into the wiki…" and "Move…" wrap. The row stays the same, so
// its annotations, tags, anchored links, doc links and replay stay with it,
// and its /doc/<slug> redirects to wherever it lives. Nothing is copied, so a
// moved doc is not a fork and records no provenance.

export type MoveIntoWikiRequest = {
  docId: string;
  namespace: WikiNamespaceChoice;
  /** The name as typed; normalized and checked here. */
  name: string;
  /** A typed variant, taken as typed; null for the server to pick the first free default. */
  variant: string | null;
  /**
   * The visibility a `PRIVATE` doc takes moving into the commons, which is
   * never `PRIVATE`; ignored for every other move, which keeps the doc's own.
   */
  visibility: DocVisibility | null;
};

/**
 * The visibility a `PRIVATE` doc or page takes on entering the commons, from
 * what the mover asked for: `SHARED` or `PUBLIC`, and `PUBLIC` only from an
 * ADMIN or EDITOR, by their role and by their row as it is in `tx`
 * (requireCanMakePublic). It is the one place a move can raise anything to
 * `PUBLIC`: every other move keeps the visibility the doc or page has.
 */
async function visibilityEnteringCommons(tx: Prisma.TransactionClient, actor: Actor, requested: DocVisibility | null): Promise<DocVisibility> {
  if (requested !== "SHARED" && requested !== "PUBLIC") {
    throw invalid("A commons page is never PRIVATE: choose SHARED or PUBLIC.");
  }
  if (requested === "PUBLIC") await requireCanMakePublic(actor, tx);
  return requested;
}

export const HAS_POSTS_REFUSED =
  "A doc with a post, a draft or a deleted one included, can't be moved into the wiki, since a wiki page publishes nothing. Fork it instead.";

/**
 * Moves a doc into the wiki. In one transaction, holding the doc's row
 * `FOR UPDATE` as its first statement (lockDoc, which every function in
 * doc-manage.ts takes too, so no byline, visibility or deletion change
 * authorised under the rules from before the move lands after it):
 *
 * 1. a missing or deleted doc is not found, and a wiki page is refused, since
 *    moving one is a rename or a move between namespaces;
 * 2. the mover can edit the doc (canEditDocRow, under the lock) and is on its
 *    byline. A move adds no one to the byline, so nobody's text ends up under
 *    a name that wasn't already on it, and the owner of a person's page is
 *    always on its byline; for the commons, the ADMIN or EDITOR on the byline
 *    is how the doc's authors choose to give up `PRIVATE` and publishing;
 * 3. the namespace, read afresh in this transaction (claimableNamespace), so a
 *    demotion committed before the move is seen by it;
 * 4. **a doc with any post is refused**, a draft, a scheduled, an unpublished
 *    and a deleted one included: `tx` is prismaIncludingDeleted's, so the
 *    count sees deleted posts, and publishing takes `FOR KEY SHARE` on this
 *    row first, so no post is written beside the count;
 * 5. the address, claimed under its lock after the row's (the order a rename
 *    takes them in), a typed variant as typed and refused when taken, none as
 *    the first free of `2`, `3`, … after the page itself, since there is no
 *    parent to name;
 * 6. a `PRIVATE` doc entering the commons takes the `SHARED` or `PUBLIC`
 *    asked for, `PUBLIC` from an ADMIN or EDITOR alone, read afresh
 *    (visibilityEnteringCommons);
 * 7. **the address, the title and the visibility are one UPDATE**, since a
 *    CHECK is checked on every statement: a `PRIVATE` doc moving into the
 *    commons written address-first fails `doc_commons_not_private`, and
 *    `PUBLIC` first fails `doc_public_only_wiki`. The title is named there,
 *    since the search vector's trigger fires by the columns a statement
 *    names, and it is the name from now on.
 *
 * Connections already open keep the access they had until they reconnect.
 */
export async function moveDocIntoWiki(actor: Actor, request: MoveIntoWikiRequest): Promise<{ path: string; editPath: string; commons: boolean }> {
  if (typeof request.docId !== "string") throw invalid("That isn't a doc.");
  const name = requireWikiName(String(request.name));
  const typed = request.variant === null ? null : requireWikiVariant(String(request.variant).trim());
  // Asked here for the refusal's sake, and again under the lock.
  const { owner, ownerUserId } = await claimableNamespace(actor, request.namespace);
  try {
    return await prismaIncludingDeleted.$transaction(async (tx) => {
      const doc = await lockDoc(tx, actor, request.docId);
      if (!doc || doc.deleted) throw new ApiError("not_found", "That doc doesn't exist.");
      if (doc.wikiName !== null) throw invalid("This doc is a wiki page already.");
      if (!doc.canEdit) throw forbidden("You don't have permission to edit this doc.");
      if (!doc.isAuthor) throw forbidden("Only someone on this doc's byline can move it into the wiki.");
      const now = await claimableNamespace(actor, request.namespace, tx);
      if (now.ownerUserId !== ownerUserId) throw forbidden("Your account changed while the doc was being moved; try again.");
      if ((await tx.post.count({ where: { docId: request.docId } })) > 0) throw invalid(HAS_POSTS_REFUSED);

      const visibility =
        ownerUserId === null && doc.visibility === "PRIVATE"
          ? await visibilityEnteringCommons(tx, actor, request.visibility)
          : doc.visibility;

      const { variant } = await claimWikiAddress(tx, actor.role, {
        ownerUserId,
        name,
        choice: typed !== null ? { variant: typed } : { defaults: { kind: "move" } },
      });
      await tx.doc.update({
        where: { id: request.docId },
        data: { wikiName: name, title: name, wikiVariant: variant, wikiOwnerUserId: ownerUserId, visibility, updatedByUserId: actor.userId },
      });
      const path = wikiPagePath({ owner, name, variant });
      return { path, editPath: `${path}/edit`, commons: ownerUserId === null };
    });
  } catch (err) {
    if (err instanceof WikiAddressTaken) {
      throw new ApiError("conflict", "That address is taken.", { path: wikiPagePath({ owner, name, variant: typed ?? "" }) });
    }
    throw err;
  }
}

/**
 * Where a move into the wiki would land with no variant typed, for the Move
 * dialog to show: the namespace's answer first, then the name's.
 */
export async function previewWikiMoveAddress(
  actor: Actor,
  request: { namespace: WikiNamespaceChoice; name: string },
): Promise<WikiAddressPreview> {
  return previewOrRefusal(async () => {
    const { owner, ownerUserId }: { owner: WikiOwner; ownerUserId: string | null } = await claimableNamespace(actor, request.namespace);
    const name = requireWikiName(String(request.name));
    return previewAddress(owner, ownerUserId, name, { kind: "move" });
  });
}

// ---------------------------------------------------------------------------
// Moving a page between namespaces, and out of the wiki (docs/WIKI.md
// "Renaming", "Moving out of the wiki").

/** Where a page goes: another namespace, under a name and a variant, or out of the wiki, as a doc. */
export type WikiPageMoveTarget =
  | {
      kind: "namespace";
      namespace: WikiNamespaceChoice;
      /** The name as typed; normalized and checked here. */
      name: string;
      /** A typed variant, taken as typed; null for the server to pick the first free default. */
      variant: string | null;
    }
  | { kind: "out" };

export type WikiPageMoveRequest = {
  docId: string;
  to: WikiPageMoveTarget;
  /**
   * The visibility the page takes where it can't keep its own: `SHARED` or
   * `PUBLIC` for a `PRIVATE` page moving into the commons, which is never
   * `PRIVATE`; `SHARED` or `PRIVATE` for a `PUBLIC` page moving out, since
   * only a wiki page is `PUBLIC`. Ignored for every other move.
   */
  visibility: DocVisibility | null;
};

/** Where a moved page lives now, and which namespaces it touched, for the caller's revalidation. */
export type WikiPageMoveResult = {
  /** The page's address, or `/doc/<slug>` for a page moved out of the wiki. */
  path: string;
  editPath: string;
  /** The address it left. */
  movedFrom: string;
  /** Whether it left the commons or entered it, which `/` may have to show or stop showing. */
  commons: boolean;
};

export const PERSON_PAGE_OWNER_ONLY = "Only the page's owner can move it out of their namespace.";
export const COMMONS_PAGE_EDITORS_ONLY = "Only an ADMIN or EDITOR on its byline can move a page out of the commons.";
export const OPEN_FIRST = "This page has never been opened, so it has no text to keep its name in. Open it once, then move it.";

/** How many times a move out starts over when a rename changes the name under it, before it gives up. */
const MOVE_OUT_ATTEMPTS = 3;

type Tx = Prisma.TransactionClient;
type LockedPage = LockedDoc & { wikiName: string };

/**
 * lockDoc, then the rule for taking a page out of its namespace (docs/WIKI.md
 * "Who may rename"): a person's page by its owner alone, read afresh
 * (ownerWhoCanAct), and a commons page by an ADMIN or EDITOR on its byline.
 * A viewer who can't read the page gets the answer for a missing one, since a
 * Forbidden would confirm that a page exists.
 */
async function lockLeavable(tx: Tx, actor: Actor, docId: string): Promise<LockedPage> {
  const doc = await lockDoc(tx, actor, docId);
  if (!doc) throw notFound("That page");
  const readable = () => canUserReadDoc(actor.userId, actor.role, { id: docId, visibility: doc.visibility });
  if (doc.wikiName === null) {
    if (!(await readable())) throw notFound("That page");
    throw invalid("That doc isn't a wiki page.");
  }
  const mayLeave =
    doc.wikiOwnerUserId !== null
      ? doc.wikiOwnerUserId === actor.userId && (await ownerWhoCanAct(doc.wikiOwnerUserId, tx)) !== null
      : canEditAnySharedDoc(actor.role) && doc.isAuthor;
  if (!mayLeave) {
    if (!(await readable())) throw notFound("That page");
    throw forbidden(doc.wikiOwnerUserId !== null ? PERSON_PAGE_OWNER_ONLY : COMMONS_PAGE_EDITORS_ONLY);
  }
  if (doc.deleted) throw invalid("A deleted page can't be moved; restore it first.");
  return { ...doc, wikiName: doc.wikiName };
}

async function ownerOf(db: Pick<Tx, "user">, ownerUserId: string | null): Promise<WikiOwner> {
  if (ownerUserId === null) return { kind: "commons" };
  const owner = await db.user.findUnique({ where: { id: ownerUserId }, select: { slug: true } });
  if (!owner) throw new Error(`A wiki page's owner ${ownerUserId} has no row.`);
  return { kind: "person", slug: owner.slug };
}

/**
 * What leaving a namespace writes to the history (docs/WIKI.md "Renaming"):
 * the page's reserved rows there released, so the names are free at once,
 * and the address it leaves recorded as released. A released row holds
 * nothing, and redirects only when nothing else answers.
 */
async function releaseNamespace(tx: Tx, actor: Actor, docId: string, doc: LockedPage, leavingKey: string): Promise<void> {
  const ownerUserId = doc.wikiOwnerUserId;
  await tx.wikiAddressHistory.updateMany({ where: { docId, ownerUserId, reserved: true }, data: { reserved: false } });
  // The page's history never names where it lives, so there is none here;
  // deleted anyway, so the row written next is its only one there.
  await tx.wikiAddressHistory.deleteMany({ where: { docId, ownerUserId, nameKey: leavingKey, variant: doc.wikiVariant } });
  await tx.wikiAddressHistory.create({
    data: { docId, ownerUserId, name: doc.wikiName, variant: doc.wikiVariant, reserved: false, movedByUserId: actor.userId },
  });
}

/** A lock's key as wiki-claim.ts builds it, for ordering two of them: the owner's id or `commons`, a slash, the name's key. */
function lockOrder(ownerUserId: string | null, key: string): string {
  return `${ownerUserId ?? "commons"}/${key}`;
}

/**
 * Moves a wiki page to another namespace or out of the wiki (docs/WIKI.md
 * "Renaming", "Moving out of the wiki"):
 *
 * - **who**: a person's page leaves `@x` by `x` alone, read afresh, and only
 *   into the commons, as an ADMIN or EDITOR; a commons page leaves the commons
 *   by an ADMIN or EDITOR on its byline, and only into their own namespace.
 *   Either may go out of the wiki. No page moves from one person's namespace
 *   to another's, since leaving `@x` is `x`'s and entering `@y` is `y`'s;
 * - **into a namespace**, under the rules for moving a doc in there
 *   (claimableNamespace, read afresh in the transaction), a `PRIVATE` page
 *   entering the commons made `SHARED` or `PUBLIC` in the same UPDATE
 *   (visibilityEnteringCommons), a page that is `PUBLIC` already staying so,
 *   and the variant defaulting as a move's does;
 * - **out of the wiki**, the name written into the ydoc's title fragment
 *   through the collab server first, with no transaction open, and a `PUBLIC`
 *   page made `SHARED` or `PRIVATE` in the UPDATE that clears the address;
 * - **either way**, under lockDoc first and then the address locks in key
 *   order, what the page held in the namespace it leaves is released, and
 *   the address it takes drops its own rows there, so its history never names
 *   where it lives.
 */
export async function moveWikiPage(actor: Actor, request: WikiPageMoveRequest): Promise<WikiPageMoveResult> {
  if (typeof request.docId !== "string") throw invalid("That isn't a page.");
  const to = request.to;
  if (to.kind === "out") return movePageOut(actor, request.docId, request.visibility);
  const name = requireWikiName(String(to.name));
  const typed = to.variant === null ? null : requireWikiVariant(String(to.variant).trim());
  // Asked here for the refusal's sake, and again under the lock.
  const target = await claimableNamespace(actor, to.namespace);
  try {
    return await prismaIncludingDeleted.$transaction(async (tx) => {
      const doc = await lockLeavable(tx, actor, request.docId);
      const now = await claimableNamespace(actor, to.namespace, tx);
      if (now.ownerUserId !== target.ownerUserId) throw forbidden("Your account changed while the page was being moved; try again.");
      // A person's page is left by its owner, and the namespace a person
      // moves a page into is their own, so a move from one person's pages to
      // another's can't be asked for: only into the namespace it is in.
      if (now.ownerUserId === doc.wikiOwnerUserId) {
        throw invalid("The page is in that namespace already: rename it instead.");
      }

      const visibility =
        now.ownerUserId === null && doc.visibility === "PRIVATE"
          ? await visibilityEnteringCommons(tx, actor, request.visibility)
          : doc.visibility;

      const from = await ownerOf(tx, doc.wikiOwnerUserId);
      const movedFrom = wikiPagePath({ owner: from, name: doc.wikiName, variant: doc.wikiVariant });
      const [leaving, taking] = await Promise.all([foldWikiName(tx, doc.wikiName), foldWikiName(tx, name)]);
      const claim = () =>
        claimWikiAddress(
          tx,
          actor.role,
          { ownerUserId: now.ownerUserId, name, choice: typed !== null ? { variant: typed } : { defaults: { kind: "move" } } },
          request.docId,
        );
      // The two address locks in key order, as a rename takes them.
      let variant: string;
      if (lockOrder(doc.wikiOwnerUserId, leaving.key) <= lockOrder(now.ownerUserId, taking.key)) {
        await lockWikiName(tx, doc.wikiOwnerUserId, doc.wikiName);
        ({ variant } = await claim());
      } else {
        ({ variant } = await claim());
        await lockWikiName(tx, doc.wikiOwnerUserId, doc.wikiName);
      }

      await releaseNamespace(tx, actor, request.docId, doc, leaving.key);
      // Coming back to an address it once had takes it as anyone would, and
      // its own released row there goes, as a rename back deletes its own.
      await tx.wikiAddressHistory.deleteMany({
        where: { docId: request.docId, ownerUserId: now.ownerUserId, nameKey: taking.key, variant },
      });
      // title beside wiki_name, for the search vector's trigger; the address
      // and the visibility in one UPDATE, for doc_commons_not_private.
      await tx.doc.update({
        where: { id: request.docId },
        data: { wikiName: name, title: name, wikiVariant: variant, wikiOwnerUserId: now.ownerUserId, visibility, updatedByUserId: actor.userId },
      });
      const path = wikiPagePath({ owner: now.owner, name, variant });
      return { path, editPath: `${path}/edit`, movedFrom, commons: doc.wikiOwnerUserId === null || now.ownerUserId === null };
    });
  } catch (err) {
    if (err instanceof WikiAddressTaken) {
      throw new ApiError("conflict", "That address is taken.", { path: wikiPagePath({ owner: target.owner, name, variant: typed ?? "" }) });
    }
    throw err;
  }
}

/**
 * A page made a doc again (docs/WIKI.md "Moving out of the wiki"). Its name
 * goes into the ydoc's title fragment through the collab server, so the doc
 * keeps its title once Doc.title reads the fragment again, and that write is
 * made with no transaction open: /admin/doc-edit answers once the store has
 * written the doc's row, which would wait on this caller's own row lock.
 * The transaction that clears the address then reads the name again under
 * the lock, and when a rename has changed it since, writes nothing and starts
 * over with the new name.
 */
async function movePageOut(actor: Actor, docId: string, requested: DocVisibility | null): Promise<WikiPageMoveResult> {
  for (let attempt = 0; attempt < MOVE_OUT_ATTEMPTS; attempt++) {
    // The rules before anything is written, the fragment being an edit.
    const before = await prismaIncludingDeleted.$transaction((tx) => lockLeavable(tx, actor, docId));
    if (before.visibility === "PUBLIC" && requested !== "SHARED" && requested !== "PRIVATE") {
      throw invalid("Only a wiki page can be PUBLIC: choose SHARED or PRIVATE for the doc.");
    }
    const ydoc = await prismaIncludingDeleted.ydoc.findUnique({ where: { id: ydocIdForDoc(docId) }, select: { id: true } });
    if (!ydoc) throw invalid(OPEN_FIRST);

    const answer = await requestDocEdit({
      docId,
      userId: actor.userId,
      role: actor.role,
      edits: [],
      title: before.wikiName,
      annotations: [],
      markAnnotations: [],
      markChips: {},
      linkParts: [],
      // The body isn't touched, so its chips need no labels.
      chipInputs: NO_CHIP_INPUTS,
    });
    if (!answer.ok) {
      if ("refusal" in answer) throw invalid(`The page's name couldn't be written into its text: ${answer.refusal.message}`);
      throw new ApiError("unavailable", `${answer.unavailable} The page wasn't moved.`);
    }

    const moved = await prismaIncludingDeleted.$transaction(async (tx) => {
      const doc = await lockLeavable(tx, actor, docId);
      // Renamed since the fragment was written: the next store would copy the
      // stale name into Doc.title, so start over with the new one.
      if (doc.wikiName !== before.wikiName) return null;
      let visibility: DocVisibility = doc.visibility;
      if (doc.visibility === "PUBLIC") {
        if (requested !== "SHARED" && requested !== "PRIVATE") {
          throw invalid("Only a wiki page can be PUBLIC: choose SHARED or PRIVATE for the doc.");
        }
        visibility = requested;
      }
      const from = await ownerOf(tx, doc.wikiOwnerUserId);
      const movedFrom = wikiPagePath({ owner: from, name: doc.wikiName, variant: doc.wikiVariant });
      const leaving = await lockWikiName(tx, doc.wikiOwnerUserId, doc.wikiName);
      await releaseNamespace(tx, actor, docId, doc, leaving.key);
      // The address and the visibility in one UPDATE, for doc_public_only_wiki;
      // the title named, for the search vector's trigger, as the name it was.
      const row = await tx.doc.update({
        where: { id: docId },
        data: { wikiName: null, wikiVariant: "", wikiOwnerUserId: null, title: doc.wikiName, visibility, updatedByUserId: actor.userId },
        select: { slug: true },
      });
      const path = `/doc/${row.slug}`;
      return { path, editPath: `${path}/edit`, movedFrom, commons: doc.wikiOwnerUserId === null };
    });
    if (moved) return moved;
  }
  throw new ApiError("conflict", "The page kept being renamed while it was being moved out; try again.");
}
