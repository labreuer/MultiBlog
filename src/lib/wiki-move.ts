import type { DocVisibility } from "@/generated/prisma/enums";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { lockDoc } from "@/lib/doc-manage";
import { wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import { claimWikiAddress, WikiAddressTaken } from "@/lib/wiki-claim";
import { claimableNamespace, requireWikiName, requireWikiVariant, type WikiNamespaceChoice } from "@/lib/wiki-create";
import { previewAddress, previewOrRefusal, type WikiAddressPreview } from "@/lib/wiki-fork";

// docs/WIKI.md "Moving a doc into the wiki" — giving an existing doc an
// address, in place, as a function taking an Actor, which the doc view's
// "Move into the wiki…" wraps. The row stays the same, so its annotations,
// tags, anchored links, doc links and replay stay with it, and its
// /doc/<slug> starts redirecting to the address. Nothing is copied, so a
// moved doc is not a fork and records no provenance.
//
// Moving between namespaces and out of the wiki (PR 5) comes later, beside
// this.

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
 * 6. **the address, the title and the visibility are one UPDATE**, since a
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

      let visibility: DocVisibility = doc.visibility;
      if (ownerUserId === null && doc.visibility === "PRIVATE") {
        if (request.visibility !== "SHARED" && request.visibility !== "PUBLIC") {
          throw invalid("A commons page is never PRIVATE: choose SHARED or PUBLIC.");
        }
        visibility = request.visibility;
      }

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
