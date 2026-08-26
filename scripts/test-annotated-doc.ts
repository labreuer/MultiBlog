// A throwaway doc with enough annotations, of enough *kinds*, to exercise the
// margin rail and the phone-landscape queue (PLAN.md §18, §18c) by hand.
//
// docs/TEST_DATA.md's throwaway rules apply: the author is an `@example.com`
// account and `delete` refuses anything whose authors aren't all
// `@example.com`. It deliberately does *not* carry the `E2E ` title prefix, so
// `npm run e2e`'s teardown sweep leaves it alone — the point of this doc is to
// still be there when you pick the phone back up.
//
// What it creates, and why each kind is here rather than "twelve annotations":
//
//   - **Three anchored by an inline mark**, written through the collab server
//     by `applyAnnotationMark` exactly as the doc *editor* writes one (§13o).
//     Their `anchorFrom`/`anchorTo` stay null and their `quotedText` empty: a
//     null `anchorFrom` *is* "look for a mark instead".
//   - **Four anchored by column indexes** — `anchorFrom`/`anchorTo`/
//     `quotedText`, no mark, which is what either *reading* view writes. These
//     are bylined to a reader rather than to the author, because that is the
//     only way they arise in life.
//   - **Three whole-doc**, with neither: the general-discussion state (§12h)
//     that the aligned rail has nowhere to put and the queue lists last.
//
// The mixture is the point. `resolveAnnotationRanges` is the one function that
// answers for both mechanisms, and a doc carrying only one of them cannot show
// whether it does.
//
// Usage:
//   npx tsx scripts/test-annotated-doc.ts                 # create
//   npx tsx scripts/test-annotated-doc.ts --visibility PRIVATE
//   npx tsx scripts/test-annotated-doc.ts delete <id|slug>
//
// **The collab server must be running** (`npm run collab`) or the three marks
// cannot be applied — `applyAnnotationMark` writes them through it, the same
// as every other caller. The script says so per annotation rather than
// failing: a doc whose marks didn't land is still a valid doc, just one where
// three annotations came out document-level.
import "dotenv/config";
import bcrypt from "bcryptjs";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import type { Prisma } from "../src/generated/prisma/client";
import type { DocVisibility, Role } from "../src/generated/prisma/enums";
import { prisma } from "../src/lib/prisma";
import { uniqueDocSlug } from "../src/lib/doc-slug";
import { uniqueUserSlug } from "../src/lib/user-slug";
import { colorForSeed } from "../src/lib/author-colors";
import { contentExtensions, titleExtensions, pmDocContentSchema } from "../src/lib/tiptap-schema";
import { docContentFromYdoc } from "../src/lib/doc-content";
import { findQuoteOccurrences } from "../src/lib/quote-occurrences";
import { seedAnnotationYdoc } from "../src/lib/annotation-ydoc-seed";
import { applyAnnotationMark } from "../src/lib/annotation-admin";
import { ydocIdForDoc, ydocIdForAnnotation } from "../src/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";

const AUTHOR_EMAIL = "test-admin@example.com";
const READER_EMAIL = "test-reader@example.com";
const TITLE = "Twelve paragraphs, annotated three ways";

// Twelve paragraphs, and every quote the annotations below anchor to appears
// exactly once in it — findQuoteOccurrences takes the first match, so a phrase
// repeated across paragraphs would silently anchor to the wrong one.
const BODY = [
  "A document is a promise about the future, made by someone who will not be there to keep it. Everything else about writing follows from that, including most of what makes it hard.",
  "The first draft exists to be wrong in a way you can see. Its purpose is not to be good; it is to move the argument out of your head, where it agrees with you, and onto a page, where it cannot.",
  "Revision is where the thinking actually happens. A sentence that resists being shortened is usually protecting a claim you have not yet worked out, and shortening it is how you find that out.",
  "Notes in the margin are older than printing and have outlived every technology that tried to replace them. They persist because they are the cheapest possible way to disagree with something without destroying it.",
  "The reason to keep the note beside the passage is not convenience. It is that a note torn loose from its sentence becomes a note about a topic, and a note about a topic is almost always worthless.",
  "Anyone who has inherited a long document knows the particular dread of an unattributed comment. Someone objected here, once, and the objection has outlasted every trace of what it was about.",
  "Deleting a paragraph is an act with consequences you cannot see from where you are standing. Somewhere a remark that made sense is now floating, and nothing will tell you until someone goes looking for it.",
  "There is a version of this problem in every collaborative system, and the honest ones admit that no answer is complete. The dishonest ones simply drop the remark and say nothing.",
  "A reader and an editor want opposite things from the same screen. The reader wants the note beside the sentence; the editor wants a list they can work through and finish.",
  "Designing for both at once produces a compromise that serves neither, which is why the good tools eventually stop pretending it is one problem and let the surface decide.",
  "The last thing anyone builds is the thing that tells you what is left to do. It is also, reliably, the first thing anyone asks for once the rest of it works.",
  "None of this is settled, and a document that claimed otherwise would be the first thing worth annotating.",
].join("\n\n");

// Quotes for the mark-anchored three (the editor's mechanism) …
const MARK_QUOTES = [
  "a promise about the future",
  "the cheapest possible way to disagree with something without destroying it",
  "the good tools eventually stop pretending it is one problem",
];

// … and for the column-anchored four (either reading view's).
const COLUMN_QUOTES = [
  "to be wrong in a way you can see",
  "a note about a topic is almost always worthless",
  "Somewhere a remark that made sense is now floating",
  "the first thing anyone asks for once the rest of it works",
];

const MARK_BODIES = [
  "Worth stating this much more plainly — the whole piece turns on it and it is buried in a subordinate clause.",
  "Is this actually true of printing? It reads as a nice line rather than a claim anyone checked.",
  "This is the argument. Everything before it is setup, and everything after it is consequence.",
];

const COLUMN_BODIES = [
  "I read this three times before it landed. Consider splitting the sentence.",
  "Strong claim, no example. One would carry more than the assertion does.",
  "\"Floating\" is doing a lot of work here. Is there a term for this already?",
  "True, and a little smug. Maybe cut the second sentence?",
];

const WHOLE_DOC_BODIES = [
  "Overall: the middle third is the strongest part and the opening does not promise it. Consider leading with paragraph five.",
  "Twelve paragraphs and no headings — is that deliberate? It reads as one breath, which may be the point.",
  "Filed for later: none of this addresses what happens when two people revise the same passage at once.",
];

function docFromText(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      ...(para ? { content: [{ type: "text", text: para }] } : {}),
    })),
  };
}

async function ensureUser(
  email: string,
  name: string,
  role: Role,
  initials: string,
): Promise<{ id: string; role: Role }> {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (existing) return existing;
  // Same shape test-user.ts creates: the documented throwaway password, and
  // emailVerified set, so the account can actually be signed in as rather than
  // only being a byline.
  const user = await prisma.user.create({
    data: {
      email,
      name,
      role,
      slug: await uniqueUserSlug(name, email),
      color: colorForSeed(email),
      passwordHash: await bcrypt.hash("testpass123", 12),
      adminInitials: initials,
      emailVerified: new Date(),
    },
    select: { id: true, role: true },
  });
  console.log(`  created ${email} (${role}, password testpass123)`);
  return user;
}

async function create(visibility: DocVisibility) {
  const author = await ensureUser(AUTHOR_EMAIL, "Test Admin", "ADMIN", "TA");
  // AUTHORIZED, because that is the lowest role that may annotate a SHARED doc
  // from its reading view (docs/PERMISSIONS.md) — the column-anchored rows
  // below are bylined to this account so they are the kind of annotation that
  // account could actually have made.
  const reader = await ensureUser(READER_EMAIL, "Test Reader", "AUTHORIZED", "TR");

  const doc = await prisma.doc.create({
    data: {
      slug: await uniqueDocSlug(TITLE),
      title: TITLE,
      visibility,
      authors: { create: { userId: author.id, bylineOrder: 0 } },
    },
  });

  // Body and title are separate Yjs fragments (PLAN.md §3d), and the title
  // fragment — not Doc.title — is canonical: seed only the body and the collab
  // server's first flush writes an empty title straight over the column.
  const seed = new Y.Doc();
  const seededBody = TiptapTransformer.toYdoc(docFromText(BODY), "default", contentExtensions);
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededBody));
  seededBody.destroy();
  const seededTitle = TiptapTransformer.toYdoc(
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: TITLE }] }] },
    "title",
    titleExtensions,
  );
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededTitle));
  seededTitle.destroy();
  const { ydoc, stateVector } = encodeYdocState(seed);
  // Write the title/prose_json cache the collab server would have written on
  // its first store debounce, from the same derivation, so the two cannot
  // disagree — seeding only the ydoc leaves prose_json NULL and every
  // non-editing surface reports the doc as empty until somebody opens it in an
  // editor (scripts/integrity/check-doc-integrity.ts found that the hard way).
  const cached = docContentFromYdoc(seed);
  seed.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);
  await prisma.doc.update({
    where: { id: doc.id },
    data: { proseJson: cached.proseJson as Prisma.InputJsonValue, title: cached.title },
  });
  console.log(`\ndoc "${doc.title}" (${visibility})  ${doc.id}`);

  // The version every column-anchored annotation below is stamped with: the
  // doc as first seeded, which is genuinely the state a reader annotating it
  // would have been looking at. PLAN.md §13n — the stamp has to be a version
  // the annotation is *locatable* at, which is what
  // scripts/integrity/check-annotation-anchors.ts replays and checks.
  const seedUpdateId = (
    await prisma.ydocUpdate.findFirst({
      where: { ydocId: ydocIdForDoc(doc.id) },
      orderBy: { id: "desc" },
      select: { id: true },
    })
  )?.id;
  if (seedUpdateId === undefined) throw new Error("The doc's seed update went missing — nothing to stamp against.");

  const bodyNode = pmDocContentSchema.nodeFromJSON(docFromText(BODY));

  async function addAnnotation(opts: {
    userId: string;
    bodyText: string;
    anchor?: { from: number; to: number; quotedText: string; stamp: bigint };
  }): Promise<string> {
    const { proseJson, ydoc: annYdoc, stateVector: annSv } = seedAnnotationYdoc(opts.bodyText);
    const annotation = await prisma.annotation.create({
      data: {
        docId: doc.id,
        userId: opts.userId,
        bodyText: opts.bodyText,
        proseJson: proseJson as Prisma.InputJsonValue,
        status: "LIVE",
        ...(opts.anchor
          ? {
              anchorFrom: opts.anchor.from,
              anchorTo: opts.anchor.to,
              quotedText: opts.anchor.quotedText,
              ydocUpdateId: opts.anchor.stamp,
            }
          : {}),
      },
    });
    // The body lives in its own ydoc, and `bodyText` is only a cache of it
    // (§13p). Skip this and the card renders empty everywhere except
    // /annotations, which reads the column.
    await ydocStore.createIfAbsent(ydocIdForAnnotation(annotation.id), annYdoc, annSv);
    return annotation.id;
  }

  console.log("\nInline, anchored by a mark in the document (the editor's mechanism):");
  for (const [index, quote] of MARK_QUOTES.entries()) {
    const [occurrence] = findQuoteOccurrences(bodyNode, quote);
    if (!occurrence) {
      console.log(`  ! quote not found, skipped: "${quote}"`);
      continue;
    }
    const id = await addAnnotation({ userId: author.id, bodyText: MARK_BODIES[index] });
    const { applied, markUpdateId } = await applyAnnotationMark({
      docId: doc.id,
      userId: author.id,
      role: author.role,
      annotationId: id,
      from: occurrence.from,
      to: occurrence.to,
      quotedText: quote,
    });
    if (!applied) {
      console.log(`  ! mark not applied (is the collab server running?) — now document-level: "${quote}"`);
      continue;
    }
    // PLAN.md §13n, as corrected: the stamp names a version the mark is
    // actually *present* at, which is the update that carried it — not the
    // state its author was looking at a moment earlier, which has no such
    // mark and would drop the card out of the rail.
    if (markUpdateId) {
      await prisma.annotation.update({ where: { id }, data: { ydocUpdateId: BigInt(markUpdateId) } });
    }
    console.log(`  ✓ "${quote.slice(0, 52)}"`);
  }

  console.log("\nInline, anchored by column indexes (either reading view's mechanism):");
  for (const [index, quote] of COLUMN_QUOTES.entries()) {
    const [occurrence] = findQuoteOccurrences(bodyNode, quote);
    if (!occurrence) {
      console.log(`  ! quote not found, skipped: "${quote}"`);
      continue;
    }
    await addAnnotation({
      userId: reader.id,
      bodyText: COLUMN_BODIES[index],
      anchor: { from: occurrence.from, to: occurrence.to, quotedText: quote, stamp: seedUpdateId },
    });
    console.log(`  ✓ ${occurrence.from}–${occurrence.to}  "${quote.slice(0, 46)}"`);
  }

  console.log("\nWhole-doc, anchored to nothing:");
  for (const [index, bodyText] of WHOLE_DOC_BODIES.entries()) {
    await addAnnotation({ userId: index === 1 ? reader.id : author.id, bodyText });
    console.log(`  ✓ "${bodyText.slice(0, 52)}…"`);
  }

  console.log(`\nRead:  /doc/${doc.slug}`);
  console.log(`Edit:  /doc/${doc.id}/edit`);
}

async function remove(idOrSlug: string) {
  const doc = await prisma.doc.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: { id: true, title: true, authors: { select: { user: { select: { email: true } } } } },
  });
  if (!doc) throw new Error(`No such doc: ${idOrSlug}`);
  // docs/TEST_DATA.md's containment guard, and its deletion-order trap: once a
  // doc's only author is gone, "no authors" is indistinguishable from a real
  // doc that lost its author some other way, so an authorless doc is refused
  // rather than assumed to be ours.
  if (doc.authors.length === 0) throw new Error(`"${doc.title}" has no authors — refusing to guess whether it is ours.`);
  const unsafe = doc.authors.map((a) => a.user.email).filter((email) => !email.endsWith("@example.com"));
  if (unsafe.length > 0) throw new Error(`"${doc.title}" is authored by ${unsafe.join(", ")} — refusing.`);

  // Annotation rows cascade with the doc, but neither their body ydocs nor the
  // doc's own have an FK back to it (PLAN.md §13a), so their ids have to be
  // captured *before* the cascade or the rows become unreachable garbage —
  // exactly as scripts/test-doc.ts's own delete does it.
  const annotationIds = (await prisma.annotation.findMany({ where: { docId: doc.id }, select: { id: true } })).map(
    (a) => a.id,
  );
  await prisma.doc.delete({ where: { id: doc.id } });
  await prisma.ydoc.deleteMany({
    where: { id: { in: [ydocIdForDoc(doc.id), ...annotationIds.map(ydocIdForAnnotation)] } },
  });
  console.log(`deleted "${doc.title}", its ydoc row, and ${annotationIds.length} annotation ydoc row(s)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "delete") {
    if (!args[1]) throw new Error("delete needs a doc id or slug.");
    await remove(args[1]);
    return;
  }
  const flag = args.indexOf("--visibility");
  const visibility = (flag === -1 ? "SHARED" : args[flag + 1]) as DocVisibility;
  if (!["PRIVATE", "SHARED", "PUBLIC"].includes(visibility)) throw new Error(`Bad visibility: ${visibility}`);
  await create(visibility);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
