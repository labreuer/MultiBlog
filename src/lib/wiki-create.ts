import type { DocVisibility, Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { canEditAnySharedDoc } from "@/lib/doc-authz";
import { createDocWithContent } from "@/lib/doc-create";
import { allowedVisibilities } from "@/lib/doc-visibility";
import { isWikiVariant, slugIsFromEmail, wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import { ownerWhoCanAct, WikiAddressTaken, type WikiOwnerRow } from "@/lib/wiki-claim";
import { checkWikiName } from "@/lib/wiki-name";

// docs/WIKI.md "Creating a page" — a new wiki page, as a function taking an
// Actor, which /wiki/new's action wraps (CLAUDE.md, "A write the UI and the
// MCP server share is a function in src/lib/"), so the MCP tool that comes
// with wiki addresses meets the same rules. doc-create.ts checks nothing; the
// rules are here, and the namespace's are asked again inside the create's
// transaction.

/** Why a person's own namespace takes no page from them, in words the form shows. */
export const NO_MANAGE_DOCS = "Your account can't create docs, so it can't create wiki pages.";
export const SLUG_FROM_EMAIL =
  "Your url is made from your email address, which a page's address would publish. An ADMIN can change it (Users, then the url).";
export const COMMONS_EDITORS_ONLY = "Only an ADMIN or EDITOR can put a page in the commons.";

/** Which namespace a claim is in, as a dialog names it. */
export type WikiNamespaceChoice = "person" | "commons";

/**
 * Why `owner` (the actor, claiming in their own namespace) may not, or null
 * when they may: a live person with canManageDocs, by a fresh read of their
 * row (ownerWhoCanAct), and a slug not made from their email.
 */
function personRefusal(owner: WikiOwnerRow | null): string | null {
  if (owner === null) return NO_MANAGE_DOCS;
  return slugIsFromEmail(owner) ? SLUG_FROM_EMAIL : null;
}

/**
 * Where a viewer may create a page: their own namespace, by a fresh read of
 * their account that finds a person able to act and a slug not made from
 * their email; and the commons, for an ADMIN or EDITOR whatever their slug.
 * `person` is null when they may not, with the reason. What the UI offers;
 * the claim asks the same again, in its transaction.
 */
export async function wikiNamespacesFor(viewer: { id: string; role: Role }): Promise<{
  person: WikiOwnerRow | null;
  personRefusal: string | null;
  commons: boolean;
}> {
  const owner = await ownerWhoCanAct(viewer.id);
  const refusal = personRefusal(owner);
  return { person: refusal === null ? owner : null, personRefusal: refusal, commons: canEditAnySharedDoc(viewer.role) };
}

/**
 * The namespace an actor claims an address in, read as they are now: their
 * own, after the fresh read and the email-slug test, on `db` (the claim's
 * transaction, so a demotion committed before it is seen); the commons, for
 * an ADMIN or EDITOR. Creating, forking and moving into the wiki each ask it.
 */
export async function claimableNamespace(
  actor: Actor,
  namespace: WikiNamespaceChoice,
  db?: Pick<Prisma.TransactionClient, "user">,
): Promise<{ owner: WikiOwner; ownerUserId: string | null }> {
  if (namespace === "person") {
    const owner = await ownerWhoCanAct(actor.userId, db);
    const refusal = personRefusal(owner);
    if (refusal !== null || owner === null) throw forbidden(refusal ?? NO_MANAGE_DOCS);
    return { owner: { kind: "person", slug: owner.slug }, ownerUserId: owner.id };
  }
  if (!canEditAnySharedDoc(actor.role)) throw forbidden(COMMONS_EDITORS_ONLY);
  return { owner: { kind: "commons" }, ownerUserId: null };
}

/** A name as the rules give it back, or the rules' message as a refusal. */
export function requireWikiName(input: string): string {
  const checked = checkWikiName(input);
  if (!checked.ok) throw invalid(checked.message);
  return checked.name;
}

/** A variant as typed, "" for the page itself, or a refusal. */
export function requireWikiVariant(variant: string): string {
  if (!isWikiVariant(variant)) {
    throw invalid("A variant is lowercase letters, digits and single dashes, or nothing for the page itself.");
  }
  return variant;
}

export type NewWikiPage = {
  namespace: WikiNamespaceChoice;
  /** The name as typed; normalized and checked here. It is the page's title. */
  name: string;
  /** "" for the page itself. Taken as typed: never picked for the creator. */
  variant: string;
  visibility: DocVisibility;
};

/** The empty body a new page starts with. */
const EMPTY_BODY = { type: "doc", content: [{ type: "paragraph" }] };

/**
 * Creates a wiki page, empty, with its title fragment seeded with the name
 * and marked as the creator's, as MCP's create_doc marks its actor's text, so
 * the doc's own record agrees with its name from the first update; the
 * creator is its byline. Into the actor's own namespace only after a fresh
 * read of their row inside the create's transaction; the commons for an
 * ADMIN or EDITOR. The address is claimed under its lock in that
 * transaction, and **a taken one is refused** rather than given the next
 * variant: here the address was typed, and a variant picked for the creator
 * would make a second page where they may have meant to reach the first. The
 * refusal names the address, which reveals nothing: whoever may create in a
 * namespace can read all of it. Returns the page's editor.
 */
export async function createWikiPage(actor: Actor, input: NewWikiPage): Promise<{ id: string; path: string; editPath: string }> {
  const name = requireWikiName(input.name);
  const variant = requireWikiVariant(input.variant);
  // Asked here for the refusal's sake, and again in the transaction.
  const { owner, ownerUserId } = await claimableNamespace(actor, input.namespace);
  const allowed = allowedVisibilities({ visibility: input.visibility, wikiName: name, wikiOwnerUserId: ownerUserId }, actor.userId);
  if (!allowed.includes(input.visibility)) throw invalid(`A page here can't be ${String(input.visibility)}.`);

  const path = wikiPagePath({ owner, name, variant });
  try {
    const doc = await createDocWithContent(actor.userId, name, EMPTY_BODY, {
      author: actor.userId,
      visibility: input.visibility,
      wiki: {
        ownerUserId,
        name,
        choice: { variant },
        actorRole: actor.role,
        verify: async (tx) => {
          const now = await claimableNamespace(actor, input.namespace, tx);
          if (now.ownerUserId !== ownerUserId) throw forbidden("Your account changed while the page was being made; try again.");
        },
      },
    });
    return { id: doc.id, path, editPath: `${path}/edit` };
  } catch (err) {
    if (err instanceof WikiAddressTaken) throw new ApiError("conflict", "That address is taken.", { path });
    throw err;
  }
}
