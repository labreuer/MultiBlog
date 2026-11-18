import type { JSONContent } from "@tiptap/core";
import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
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
// `/welcome` shows WELCOME_PAGE_NAME the same way, for whoever is reading
// (docs/EMAIL.md §10, "The welcome page").

/** The commons page whose body is the landing page's preamble; typed as one of the held names, so the two can't part. */
export const FRONT_PAGE_NAME: (typeof HELD_COMMONS_NAMES)[number] = "Front Page";

/**
 * The commons page `/welcome` shows a new account (docs/EMAIL.md §10, "The
 * welcome page"); held, so an AUTHOR on a commons page's byline can't rename
 * that page to it and greet every new account with their own text.
 */
export const WELCOME_PAGE_NAME: (typeof HELD_COMMONS_NAMES)[number] = "New Account Welcome";

type HeldCommonsName = (typeof HELD_COMMONS_NAMES)[number];

/**
 * A held commons page's address as a `where`: the commons (no owner), the
 * page itself (variant ""), and the name matched by its key, which is folded
 * by `wiki_name_key` in the database and nowhere else (docs/WIKI.md "Case"),
 * so `front page` and `FRONT PAGE` are the same page. A unique index keeps
 * one live page at it. Visibility and deletion are each caller's.
 */
async function heldPageAddressWhere(name: HeldCommonsName): Promise<Prisma.DocWhereInput> {
  const { key } = await foldWikiName(prisma, name);
  return { wikiOwnerUserId: null, wikiName: { not: null }, wikiNameKey: key, wikiVariant: "" };
}

/**
 * A held commons page's body, ready for a post-side render, when `viewer`
 * may read it under the wiki read rule (`readableWikiDocsWhere`), and null
 * otherwise. `publicOnly` asks for PUBLIC whoever the viewer is, as the front
 * page does, which anyone reads.
 *
 * proseJson is null for a doc moved into the wiki before anything stored it:
 * the page is then left out rather than decoded from its ydoc, a state that
 * resolves itself the moment anyone types a character. Only proseJson and
 * the doc's chip styles are selected, so the page's name is never shown.
 *
 * The conversion is the one postContentFromYdoc applies before a post
 * snapshot (§15b): a doc's prose can carry authorHighlight/annotation marks
 * and entity chips the public renderer's contentExtensions doesn't know, and
 * rendering them unconverted would 500 the page.
 */
export async function heldCommonsPageBody(
  name: HeldCommonsName,
  viewer: { id: string; role: Role } | null,
  { publicOnly = false }: { publicOnly?: boolean } = {},
): Promise<JSONContent | null> {
  const and: Prisma.DocWhereInput[] = [await heldPageAddressWhere(name), readableWikiDocsWhere(viewer)];
  if (publicOnly) and.push({ visibility: "PUBLIC" });
  const doc = await prisma.doc.findFirst({ where: { AND: and }, select: { proseJson: true, chipStyles: true } });
  if (!doc?.proseJson) return null;
  return docJsonForPostSide(doc.proseJson as JSONContent, parseChipStyles(doc.chipStyles));
}

// Reads no session, so `/` keeps its ISR cache (docs/BLOG.md §8): the viewer
// is null, and the wiki read rule's `where` for a null viewer is the live
// PUBLIC pages. The writes that put a page on or take it off revalidate `/`
// (src/lib/front-page-revalidate.ts).
export async function getFrontPagePreamble(): Promise<JSONContent | null> {
  return heldCommonsPageBody(FRONT_PAGE_NAME, null, { publicOnly: true });
}

/**
 * Whether the welcome page would reach a new account: a live commons page of
 * the held name that every AUTHOR may read, SHARED or PUBLIC. What the
 * minting script warns on before anything is printed.
 */
export async function welcomePageReachesAuthors(): Promise<boolean> {
  const found = await prisma.doc.count({
    where: {
      AND: [await heldPageAddressWhere(WELCOME_PAGE_NAME), { deletedByUserId: null, visibility: { in: ["SHARED", "PUBLIC"] } }],
    },
  });
  return found > 0;
}

/**
 * Whether a doc is at the front page's address, whatever its visibility and
 * whether or not it is deleted: what the editor asks, to say that lowering,
 * renaming or deleting the page takes the preamble off the landing page.
 */
export async function isFrontPageAddress(docId: string): Promise<boolean> {
  const found = await prismaIncludingDeleted.doc.count({ where: { AND: [{ id: docId }, await heldPageAddressWhere(FRONT_PAGE_NAME)] } });
  return found > 0;
}
