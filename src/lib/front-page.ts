import type { JSONContent } from "@tiptap/core";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, prismaIncludingDeleted } from "./prisma";
import { docJsonForPostSide } from "./post-content";
import { parseChipStyles } from "./entity-chips/settings";
import { readableWikiDocsWhere } from "./doc-authz";
import { foldWikiName } from "./wiki-claim";
import type { HELD_COMMONS_NAMES } from "./wiki-address";

// docs/WIKI.md "The front page", docs/BLOG.md §1 "The preamble" — the
// landing page's preamble is the body of the commons page named
// FRONT_PAGE_NAME, when it is PUBLIC, and nothing otherwise. The name is one
// of the commons names held for ADMIN and EDITOR (HELD_COMMONS_NAMES), so
// only they can give a page this address, and PUBLIC is what puts it here.

/** The commons page whose body is the landing page's preamble; typed as one of the held names, so the two can't part. */
export const FRONT_PAGE_NAME: (typeof HELD_COMMONS_NAMES)[number] = "Front Page";

/**
 * The front page's address as a `where`: the commons (no owner), the page
 * itself (variant ""), and the name matched by its key, which is folded by
 * `wiki_name_key` in the database and nowhere else (docs/WIKI.md "Case"),
 * so `front page` and `FRONT PAGE` are the same page. A unique index keeps
 * one live page at it. Visibility and deletion are each caller's.
 */
async function frontPageAddressWhere(): Promise<Prisma.DocWhereInput> {
  const { key } = await foldWikiName(prisma, FRONT_PAGE_NAME);
  return { wikiOwnerUserId: null, wikiName: { not: null }, wikiNameKey: key, wikiVariant: "" };
}

// Reads no session, so `/` keeps its ISR cache (docs/BLOG.md §8): the viewer
// is null, and the wiki read rule's `where` for a null viewer is the live
// PUBLIC pages. The writes that put a page on or take it off revalidate `/`
// (src/lib/front-page-revalidate.ts).
//
// Only proseJson and the doc's chip styles are selected, so the page's name
// is never shown: nothing reads it.
export async function getFrontPagePreamble(): Promise<JSONContent | null> {
  const doc = await prisma.doc.findFirst({
    where: { AND: [await frontPageAddressWhere(), readableWikiDocsWhere(null), { visibility: "PUBLIC" }] },
    select: { proseJson: true, chipStyles: true },
  });

  // proseJson is null for a doc moved into the wiki before anything stored
  // it — omit the preamble rather than pay a ydoc decode on a statically
  // generated page for a state that resolves itself the moment anyone types
  // a character.
  if (!doc?.proseJson) {
    return null;
  }

  // The same conversion postContentFromYdoc applies before a post snapshot
  // (§15b): a doc's prose can carry authorHighlight/annotation marks and
  // entity chips the public renderer's contentExtensions doesn't know, and
  // rendering them unconverted would 500 this page.
  return docJsonForPostSide(doc.proseJson as JSONContent, parseChipStyles(doc.chipStyles));
}

/**
 * Whether a doc is at the front page's address, whatever its visibility and
 * whether or not it is deleted: what the editor asks, to say that lowering,
 * renaming or deleting the page takes the preamble off the landing page.
 */
export async function isFrontPageAddress(docId: string): Promise<boolean> {
  const found = await prismaIncludingDeleted.doc.count({ where: { AND: [{ id: docId }, await frontPageAddressWhere()] } });
  return found > 0;
}
