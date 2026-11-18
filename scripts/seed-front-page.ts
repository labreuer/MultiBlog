// Creates the page the landing page's preamble is sourced from — the commons'
// `Front Page`, PUBLIC (docs/WIKI.md "The front page", docs/BLOG.md §1) — if
// there isn't one. Never clears anything — deliberately not folded into
// seed-sample-data.ts as the primary path, since that script empties the
// content tables wholesale and isn't something to point at a database with
// real content in it.
//
// Usage:
//   npx tsx scripts/seed-front-page.ts
//
// No-op (prints a message and exits 0) if a live page is already at the
// commons' `Front Page` address, whatever its visibility, so running this
// twice is safe; one that isn't PUBLIC is said so, since it shows nothing.
// Made by the earliest-created ADMIN, since this is site content with no
// natural single author; the script refuses to run if there isn't one yet
// (create one first — sign up and promote via /users, or
// scripts/test-user.ts for a throwaway).
//
// The page is made as createWikiPage (src/lib/wiki-create.ts) makes one —
// the same name and namespace checks, the address claimed under its lock in
// the create's transaction — but with its sample body in place of the empty
// one that function starts a page with, through createDocWithContent's
// `wiki` option, which is what createWikiPage itself calls. The body is
// written straight into the new doc's ydoc, which is safe only because
// nobody can have the page open yet.

import "dotenv/config";
import type { JSONContent } from "@tiptap/core";
import { prisma, prismaIncludingDeleted } from "../src/lib/prisma";
import { createDocWithContent } from "../src/lib/doc-create";
import { allowedVisibilities } from "../src/lib/doc-visibility";
import { FRONT_PAGE_NAME } from "../src/lib/front-page";
import { foldWikiName, WikiAddressTaken } from "../src/lib/wiki-claim";
import { claimableNamespace, requireWikiName } from "../src/lib/wiki-create";
import { wikiPagePath } from "../src/lib/wiki-address";
import type { Actor } from "../src/lib/actor";

const SAMPLE_TEXT = [
  "Welcome to MultiBlog — a multi-author blog with real-time collaborative editing, revision history, and quote-anchored comments.",
  "This paragraph is the site's preamble, sourced from the wiki page Front Page in the commons, while that page is PUBLIC. Edit the page (at /wiki/commons/Front_Page) to change what appears here — its name is never shown, only its text.",
].join("\n\n");

function docFromText(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      content: [{ type: "text", text: para }],
    })),
  };
}

async function main() {
  const name = requireWikiName(FRONT_PAGE_NAME);
  const path = wikiPagePath({ owner: { kind: "commons" }, name, variant: "" });

  // The name matched by its key, as getFrontPagePreamble matches it: the
  // fold is the database's (docs/WIKI.md "Case").
  const { key } = await foldWikiName(prisma, name);
  const existing = await prismaIncludingDeleted.doc.findFirst({
    where: { wikiOwnerUserId: null, wikiName: { not: null }, wikiNameKey: key, wikiVariant: "", deletedByUserId: null },
    select: { id: true, visibility: true },
  });
  if (existing) {
    const shown = existing.visibility === "PUBLIC" ? "" : ` It is ${existing.visibility}, so the landing page shows no preamble until it is made PUBLIC.`;
    console.log(`The commons' ${FRONT_PAGE_NAME} already exists (${existing.id}, ${path}) — nothing to do.${shown}`);
    return;
  }

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", worksForUserId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, role: true },
  });
  if (!admin) {
    throw new Error("No ADMIN user exists yet — create one before seeding the front page.");
  }
  const actor: Actor = { userId: admin.id, role: admin.role };

  // createWikiPage's checks, asked as it asks them: the commons is an
  // ADMIN's or EDITOR's, and a commons page may be PUBLIC.
  const { ownerUserId } = await claimableNamespace(actor, "commons");
  const visibility = "PUBLIC";
  if (!allowedVisibilities({ visibility, wikiName: name, wikiOwnerUserId: ownerUserId }, actor.userId).includes(visibility)) {
    throw new Error(`A commons page can't be ${visibility}.`);
  }

  try {
    const doc = await createDocWithContent(actor.userId, name, docFromText(SAMPLE_TEXT), {
      author: actor.userId,
      visibility,
      wiki: {
        ownerUserId,
        name,
        choice: { variant: "" },
        actorRole: actor.role,
        verify: async (tx) => {
          await claimableNamespace(actor, "commons", tx);
        },
      },
    });
    console.log(`Created the commons' ${FRONT_PAGE_NAME}, PUBLIC: doc ${doc.id} (${path}), by ${admin.email}.`);
  } catch (err) {
    if (err instanceof WikiAddressTaken) {
      console.log(`The commons' ${FRONT_PAGE_NAME} was made meanwhile (${path}) — nothing to do.`);
      return;
    }
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
