// Creates the doc the landing page's preamble is sourced from (PLAN.md §17c)
// if one doesn't already exist. Never clears anything — deliberately not
// folded into seed-sample-data.ts as the primary path, since that script
// empties the content tables wholesale and isn't something to point at a
// database with real content in it.
//
// Usage:
//   npx tsx scripts/seed-front-page.ts
//
// No-op (prints a message and exits 0) if a doc titled FRONT_PAGE_DOC_TITLE
// already exists — src/lib/front-page.ts's own first-created-wins lookup, so
// running this twice is safe. Attributed to the earliest-created ADMIN user,
// since this is site content with no natural single author; the script
// refuses to run if there isn't one yet (create one first — sign up and
// promote via /users, or scripts/test-user.ts for a throwaway).
//
// Mechanics copied from seed-sample-data.ts's createDoc rather than
// reinvented: the ydoc row is created eagerly (§12b), and the title is
// seeded into the title fragment as well as the Doc.title column — the
// fragment is canonical (§3d), and server/doc-cache.ts would otherwise
// overwrite the column with an empty title on the collab server's first
// flush.

import "dotenv/config";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import { prisma } from "../src/lib/prisma";
import { uniqueDocSlug } from "../src/lib/doc-slug";
import { contentExtensions, titleExtensions } from "../src/lib/tiptap-schema";
import { docContentFromYdoc } from "../src/lib/doc-content";
import { FRONT_PAGE_DOC_TITLE } from "../src/lib/front-page";
import { ydocIdForDoc } from "../src/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";
import type { Prisma } from "../src/generated/prisma/client";

const SAMPLE_TEXT = [
  "Welcome to MultiBlog — a multi-author blog with real-time collaborative editing, revision history, and quote-anchored comments.",
  "This paragraph is the site's preamble, sourced from a doc titled “FRONT PAGE”. Edit that doc (from /docs, or by opening it directly) to change what appears here — the doc's own title is never shown, only its body.",
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
  const existing = await prisma.doc.findFirst({
    where: { title: { equals: FRONT_PAGE_DOC_TITLE, mode: "insensitive" } },
  });
  if (existing) {
    console.log(`A doc titled "${FRONT_PAGE_DOC_TITLE}" already exists (${existing.id}) — nothing to do.`);
    return;
  }

  const author = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    orderBy: { createdAt: "asc" },
  });
  if (!author) {
    throw new Error("No ADMIN user exists yet — create one before seeding the front-page doc.");
  }

  const doc = await prisma.doc.create({
    data: {
      slug: await uniqueDocSlug(FRONT_PAGE_DOC_TITLE),
      title: FRONT_PAGE_DOC_TITLE,
      visibility: "PRIVATE",
      authors: { create: { userId: author.id, bylineOrder: 0 } },
    },
  });

  const seed = new Y.Doc();
  const seededBody = TiptapTransformer.toYdoc(docFromText(SAMPLE_TEXT), "default", contentExtensions);
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededBody));
  seededBody.destroy();
  const seededTitle = TiptapTransformer.toYdoc(
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: FRONT_PAGE_DOC_TITLE }] }] },
    "title",
    titleExtensions,
  );
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededTitle));
  seededTitle.destroy();
  const { ydoc, stateVector } = encodeYdocState(seed);

  const cached = docContentFromYdoc(seed);
  seed.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);
  await prisma.doc.update({
    where: { id: doc.id },
    data: { proseJson: cached.proseJson as Prisma.InputJsonValue, title: cached.title },
  });

  console.log(`Created "${FRONT_PAGE_DOC_TITLE}" doc ${doc.id} (/doc/${doc.slug}), authored by ${author.email}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
