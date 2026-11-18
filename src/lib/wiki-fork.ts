import type { DocVisibility } from "@/generated/prisma/enums";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { createDocWithContent } from "@/lib/doc-create";
import { checkForkParent, readForkSource, type ForkParent } from "@/lib/doc-fork";
import { allowedVisibilities } from "@/lib/doc-visibility";
import { forkSeed } from "@/lib/fork-seed";
import { firstFreeVariant, lentVariant, wikiPagePath, type VariantDefaults, type WikiOwner } from "@/lib/wiki-address";
import { foldWikiName, takenVariants, WikiAddressTaken } from "@/lib/wiki-claim";
import { claimableNamespace, requireWikiName, requireWikiVariant, type WikiNamespaceChoice } from "@/lib/wiki-create";

// docs/WIKI.md "Forking into the wiki" — main's fork (src/lib/doc-fork.ts)
// with an address, as a function taking an Actor, which the Fork dialog's
// action wraps when its Where is a namespace. Everything main checks before a
// fork is checked by main's code in main's order (readForkSource), the seed is
// main's (forkSeed), and the create is main's (createDocWithContent) with its
// `wiki` option. What the wiki adds is the target namespace's rules, PUBLIC,
// the name and the variant.

export type WikiForkRequest = {
  parentId: string;
  /** The version the reader is looking at on the parent's scrub bar, as text; null for the doc as it is now. */
  revision: string | null;
  namespace: WikiNamespaceChoice;
  /** The name as typed; normalized and checked here. */
  name: string;
  /** A typed variant, taken as typed; null for the server to pick the first free default. */
  variant: string | null;
  visibility: DocVisibility;
};

/**
 * The sequence a fork of `parent` into `target` walks when no variant is
 * typed: the page itself, the variant a `PUBLIC` parent lends (its owner's
 * slug, or `commons`), then `2`, `3`, ….
 */
function forkDefaults(parent: ForkParent, target: WikiOwner): VariantDefaults {
  return { kind: "fork", lent: lentVariant({ visibility: parent.visibility, owner: parent.wikiOwner }, target) };
}

/** The visibility a fork into `ownerUserId`'s namespace (null: the commons) may take, or a refusal. */
function requireForkVisibility(actor: Actor, visibility: DocVisibility, name: string, ownerUserId: string | null): DocVisibility {
  const allowed = allowedVisibilities({ visibility, wikiName: name, wikiOwnerUserId: ownerUserId }, actor.userId);
  if (!allowed.includes(visibility)) throw invalid(`A page here can't be ${String(visibility)}.`);
  return visibility;
}

/**
 * Forks a doc into the wiki: readForkSource's checks and read, in main's
 * order, then the target namespace (claimableNamespace, read afresh inside
 * the create's transaction as well), the visibility against
 * allowedVisibilities for the page it will be, then the create, which locks
 * the parent's row `FOR KEY SHARE` before it claims the address
 * (docs/WIKI.md "Claiming an address"). With no variant typed, the server
 * walks the fork's default sequence under the lock; a typed one that is taken
 * is refused, naming the address.
 *
 * The visibility is the forker's choice, whatever the parent's, `PUBLIC`
 * included; the commons' pages are never `PRIVATE`. Returns the fork's wiki
 * editor.
 */
export async function forkIntoWiki(actor: Actor, request: WikiForkRequest): Promise<{ id: string; path: string; editPath: string }> {
  const name = requireWikiName(String(request.name));
  const typed = request.variant === null ? null : requireWikiVariant(String(request.variant).trim());

  const { parent, state, version } = await readForkSource(actor, request.parentId, request.revision);
  const { owner, ownerUserId } = await claimableNamespace(actor, request.namespace);
  const visibility = requireForkVisibility(actor, request.visibility, name, ownerUserId);
  const seed = forkSeed(state);
  try {
    // The title fragment is the parent's at the version, as main's fork
    // seeds it; the row's title is the name (the `wiki` option), and nothing
    // on a wiki page shows the fragment ("The name is the title").
    const created = await createDocWithContent(actor.userId, seed.title, seed.body, {
      visibility,
      forkedFrom: { docId: parent.id, updateId: version },
      chipStyles: seed.chipStyles,
      wiki: {
        ownerUserId,
        name,
        choice: typed !== null ? { variant: typed } : { defaults: forkDefaults(parent, owner) },
        actorRole: actor.role,
        verify: async (tx) => {
          const now = await claimableNamespace(actor, request.namespace, tx);
          if (now.ownerUserId !== ownerUserId) throw forbidden("Your account changed while the page was being made; try again.");
        },
      },
    });
    const path = wikiPagePath({ owner, name, variant: created.wikiVariant });
    return { id: created.id, path, editPath: `${path}/edit` };
  } catch (err) {
    if (err instanceof WikiAddressTaken) {
      throw new ApiError("conflict", "That address is taken.", { path: wikiPagePath({ owner, name, variant: typed ?? "" }) });
    }
    throw err;
  }
}

/** What a dialog shows for the address a claim with no variant typed would get. */
export type WikiAddressPreview = { ok: true; path: string } | { ok: false; error: string };

/**
 * The address a claim of `name` in `owner`'s namespace would get with no
 * variant typed, walking `defaults` past what is taken now: a preview, read
 * without the address lock, so the server may still pick the next one when
 * the form is sent ("Claiming an address").
 */
export async function previewAddress(owner: WikiOwner, ownerUserId: string | null, name: string, defaults: VariantDefaults): Promise<string> {
  // A transaction's client only for the type takenVariants takes; nothing is
  // locked or written.
  const taken = await prismaIncludingDeleted.$transaction(async (tx) => {
    const { key } = await foldWikiName(tx, name);
    return takenVariants(tx, ownerUserId, key);
  });
  return wikiPagePath({ owner, name, variant: firstFreeVariant(defaults, taken) });
}

/** A refusal in the words the surface shows; anything else is a fault and is thrown. */
export async function previewOrRefusal(run: () => Promise<string>): Promise<WikiAddressPreview> {
  try {
    return { ok: true, path: await run() };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Where a fork into the wiki would land with no variant typed, for the Fork
 * dialog to show. A deleted or unreadable parent is answered as the fork
 * would answer it (checkForkParent), before anything is said about the
 * address; then the namespace, then the name.
 */
export async function previewWikiForkAddress(
  actor: Actor,
  request: { parentId: string; namespace: WikiNamespaceChoice; name: string },
): Promise<WikiAddressPreview> {
  return previewOrRefusal(async () => {
    const parent = await checkForkParent(actor, request.parentId);
    const { owner, ownerUserId } = await claimableNamespace(actor, request.namespace);
    const name = requireWikiName(String(request.name));
    return previewAddress(owner, ownerUserId, name, forkDefaults(parent, owner));
  });
}
