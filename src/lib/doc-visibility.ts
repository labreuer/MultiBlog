import type { DocVisibility } from "@/generated/prisma/enums";

// docs/WIKI.md "`PUBLIC` outside the wiki's routes" — a doc's visibility,
// beyond the two tiers the rest of the app was written for. Browser-safe: the
// visibility selects call allowedVisibilities, and the predicates in
// doc-authz.ts and the pages ask isSharedOrPublic.
//
// PUBLIC is a wiki page's alone (the doc_public_only_wiki CHECK), and outside
// the wiki's own read rule it behaves exactly as SHARED: readable by anyone
// with canViewDocs, editable as a SHARED doc is. So every "is it SHARED" in a
// doc rule is "is it SHARED or PUBLIC", asked through the two forms below,
// over one pair of values. A bare `=== "SHARED"` or `{ visibility: "SHARED" }`
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
  visibility: DocVisibility;
  wikiName: string | null;
  wikiOwnerUserId: string | null;
};

/**
 * The values `viewerId` may set `doc` to — what the visibility selects offer,
 * and what setDocVisibility accepts, so the two can't differ. Who may set a
 * doc's visibility at all is a separate question (doc-manage.ts); this only
 * says to what.
 *
 * - a doc that isn't a wiki page: PRIVATE and SHARED;
 * - a wiki page: PUBLIC as well;
 * - a commons page: never PRIVATE (the doc_commons_not_private CHECK);
 * - a person's page, for anyone but its owner (a co-author, or an ADMIN
 *   taking it down): its current value and those below it, since raising it
 *   is the owner's alone.
 */
export function allowedVisibilities(doc: VisibilityTarget, viewerId: string | null): DocVisibility[] {
  if (doc.wikiName === null) return ["PRIVATE", "SHARED"];
  if (doc.wikiOwnerUserId === null) return ["SHARED", "PUBLIC"];
  if (doc.wikiOwnerUserId === viewerId) return [...ORDER];
  return ORDER.slice(0, ORDER.indexOf(doc.visibility) + 1);
}

/** A file's values, which its selects offer: a file shares the enum and never takes PUBLIC (the file_not_public CHECK), which file-manage.ts refuses. */
export const FILE_VISIBILITIES: readonly DocVisibility[] = ["PRIVATE", "SHARED"];

/**
 * Said beside every choice that offers PUBLIC (docs/WIKI.md "Public pages"):
 * the Settings panel's select and the create, fork and move dialogs. A public
 * page's links lead where they lead, and their text goes public with it: the
 * link picker writes a linked doc's title as the link's text.
 */
export const PUBLIC_VISIBILITY_NOTE =
  "PUBLIC: anyone can read it, signed out included, and with it the text of its links, such as the titles of the docs it links to.";
