import type { DocVisibility, Role } from "@/generated/prisma/enums";
import { canMakePagesPublic } from "@/lib/role-checks";

// docs/WIKI.md "`PUBLIC` outside the wiki's routes" — a doc's visibility,
// beyond the two tiers the rest of the app was written for. Browser-safe: the
// visibility selects call allowedVisibilities, and the predicates in
// doc-authz.ts and the pages ask isSharedOrPublic.
//
// PUBLIC is a wiki page's alone (the doc_public_only_wiki CHECK), made so by
// an ADMIN or EDITOR alone (canMakePagesPublic), and outside the wiki's own
// read rule it behaves exactly as SHARED: readable by anyone with
// canViewDocs, editable as a SHARED doc is. So every "is it SHARED" in a doc
// rule is "is it SHARED or PUBLIC", asked through the two forms below, over
// one pair of values. A bare `=== "SHARED"` or `{ visibility: "SHARED" }`
// compiles and is wrong: it would hide a public page from its own author.

const SHARED_OR_PUBLIC: readonly DocVisibility[] = ["SHARED", "PUBLIC"];

/** Whether a doc is open to every reader with canViewDocs: SHARED, or PUBLIC, which behaves as SHARED outside the wiki's routes. */
export function isSharedOrPublic(visibility: DocVisibility): boolean {
  return SHARED_OR_PUBLIC.includes(visibility);
}

/** `isSharedOrPublic` as a Prisma filter on a doc's `visibility`. A fresh object each call, so no caller can mutate another's. */
export function sharedOrPublic(): { in: DocVisibility[] } {
  return { in: [...SHARED_OR_PUBLIC] };
}

/** Lowest first: lowering is moving left. */
const ORDER: readonly DocVisibility[] = ["PRIVATE", "SHARED", "PUBLIC"];

/** The columns allowedVisibilities reads: the doc's visibility and its wiki address. */
export type VisibilityTarget = {
  /** The value the doc has now. A page being made has none: newPageVisibilities is for that. */
  visibility: DocVisibility;
  wikiName: string | null;
  wikiOwnerUserId: string | null;
};

/** Whom the rules below ask about: the viewer's id and role, or null for nobody signed in. */
export type VisibilityViewer = { id: string; role: Role } | null;

/**
 * The values `viewer` may set `doc` to — what the visibility selects offer,
 * and what setDocVisibility accepts, so the two can't differ. Who may set a
 * doc's visibility at all is a separate question (doc-manage.ts); this only
 * says to what. `doc` is a doc that exists, with the visibility it has now:
 * for a page that is being made, ask newPageVisibilities, or the value asked
 * for would be taken for one the page already has.
 *
 * - a doc that isn't a wiki page: PRIVATE and SHARED;
 * - a wiki page: PUBLIC as well, **for a viewer who may make pages public**
 *   (canMakePagesPublic: ADMIN and EDITOR). Anyone else is offered PUBLIC
 *   only on a page that already is PUBLIC, so the select shows its value and
 *   they can lower it, and can't put it back;
 * - a commons page: never PRIVATE (the doc_commons_not_private CHECK);
 * - a person's page, for anyone but its owner (a co-author, or an ADMIN
 *   taking it down): its current value and those below it, since raising it
 *   is the owner's alone, whatever the viewer's role.
 */
export function allowedVisibilities(doc: VisibilityTarget, viewer: VisibilityViewer): DocVisibility[] {
  if (doc.wikiName === null) return ["PRIVATE", "SHARED"];
  return pageVisibilities(doc.wikiOwnerUserId, doc.visibility, viewer);
}

/**
 * The values `viewer` may give a wiki page they are making in a namespace
 * (`wikiOwnerUserId`, null for the commons): what the create and fork forms
 * offer, and what createWikiPage and forkIntoWiki accept. A page being made
 * has no value yet, so nothing keeps PUBLIC for a viewer who may not make
 * pages public; and nobody makes a page in another person's namespace.
 */
export function newPageVisibilities(wikiOwnerUserId: string | null, viewer: VisibilityViewer): DocVisibility[] {
  return pageVisibilities(wikiOwnerUserId, null, viewer);
}

/** A wiki page's values for a viewer: `current` is the value it has, null for a page not made yet. */
function pageVisibilities(ownerUserId: string | null, current: DocVisibility | null, viewer: VisibilityViewer): DocVisibility[] {
  let values: readonly DocVisibility[];
  if (ownerUserId === null) values = ["SHARED", "PUBLIC"];
  else if (viewer !== null && ownerUserId === viewer.id) values = ORDER;
  else values = current === null ? [] : ORDER.slice(0, ORDER.indexOf(current) + 1);
  const mayMakePublic = viewer !== null && canMakePagesPublic(viewer.role);
  return values.filter((value) => value !== "PUBLIC" || mayMakePublic || current === "PUBLIC");
}

/** A file's values, which its selects offer: a file shares the enum and never takes PUBLIC (the file_not_public CHECK), which file-manage.ts refuses. */
export const FILE_VISIBILITIES: readonly DocVisibility[] = ["PRIVATE", "SHARED"];

/**
 * Said beside every choice that offers PUBLIC (docs/WIKI.md "Public pages"),
 * and only there: the Settings panel's select and the create, fork and move
 * dialogs. A public page's links lead where they lead, and their text goes
 * public with it: the link picker writes a linked doc's title as the link's
 * text.
 */
export const PUBLIC_VISIBILITY_NOTE =
  "PUBLIC: anyone can read it, signed out included, and with it the text of its links, such as the titles of the docs it links to.";
