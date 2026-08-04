// Create or delete throwaway docs for manual testing (PLAN.md §12). Only
// ever touches docs authored solely by @example.com throwaway accounts (see
// test-user.ts) — delete refuses a doc with any other author, so it can't
// touch real content even by mistake, same convention as test-post.ts.
//
// Usage:
//   npx tsx scripts/test-doc.ts create <authorEmail> [--visibility=PRIVATE|SHARED] [title]
//   npx tsx scripts/test-doc.ts delete <slugOrId>
// authorEmail must be an existing @example.com user — create one first with
// scripts/test-user.ts create. title defaults to "Test doc <timestamp>".
// --visibility defaults to PRIVATE.
//
// create also eagerly creates the doc's ydoc row (PLAN.md §12b, matching
// what createDocAction does from the app) — the doc is immediately editable
// without needing onLoadDocument's own forgiving-fallback path to run first.
// delete removes the doc row, its derived ydoc:<id> row, and every one of
// its annotations' own ydoc:annotation:<id> rows (§13a) — none of these
// tables have a foreign key back to the ydoc they own (§12b/§13a), so
// nothing cascades any of it automatically; skipping it would leak rows with
// no owning doc/annotation, which is exactly what scripts/test-ydoc.ts's own
// containment guard exists to not have to clean up (neither prefix is ever
// ydoc:test-).
// Delete docs before deleting their author with test-user.ts delete — once
// a doc's only author is gone, "no authors" is indistinguishable from a
// real doc that lost its author some other way, so delete refuses it.

import "dotenv/config";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prisma } from "../src/lib/prisma";
import { uniqueDocSlug } from "../src/lib/doc-slug";
import { docTitleOrFallback } from "../src/lib/doc-title";
import { titleExtensions } from "../src/lib/tiptap-schema";
import { docContentFromYdoc } from "../src/lib/doc-content";
import { ydocIdForDoc, ydocIdForAnnotation } from "../src/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";
import { DocVisibility } from "../src/generated/prisma/enums";
import type { Prisma } from "../src/generated/prisma/client";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const VISIBILITY_VALUES = Object.values(DocVisibility);

function parseCreateArgs(args: string[]): { title: string; visibility: DocVisibility } {
  const titleWords: string[] = [];
  let visibility: DocVisibility = "PRIVATE";

  for (const arg of args) {
    if (arg.startsWith("--visibility=")) {
      const value = arg.slice("--visibility=".length).toUpperCase();
      if (!VISIBILITY_VALUES.includes(value as DocVisibility)) {
        throw new Error(`Invalid --visibility value "${value}" — must be one of ${VISIBILITY_VALUES.join(", ")}.`);
      }
      visibility = value as DocVisibility;
    } else {
      titleWords.push(arg);
    }
  }

  return { title: titleWords.join(" ").trim(), visibility };
}

async function create(authorEmail: string, title: string, visibility: DocVisibility) {
  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) {
    console.error(`${authorEmail} does not exist. Create it first with: npx tsx scripts/test-user.ts create ${authorEmail}`);
    process.exitCode = 1;
    return;
  }

  const slug = await uniqueDocSlug(title);
  const doc = await prisma.doc.create({
    data: {
      slug,
      title,
      visibility,
      authors: { create: { userId: author.id, bylineOrder: 0 } },
    },
  });

  // The title is its own Yjs fragment (PLAN.md §3d) and *it*, not the column,
  // is canonical: server/doc-cache.ts writes the fragment through to Doc.title
  // on every store debounce, empty included (§12n). Create the ydoc without
  // one and the title this script was asked for survives only until somebody
  // opens the doc — the first flush silently renames it to "Untitled".
  const seed = new Y.Doc();
  const seededTitle = TiptapTransformer.toYdoc(
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }] },
    "title",
    titleExtensions,
  );
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededTitle));
  seededTitle.destroy();

  const { ydoc, stateVector } = encodeYdocState(seed);
  // Write the same cache the collab server would, through the same derivation
  // (server/doc-cache.ts uses docContentFromYdoc too), so the row is
  // self-consistent from creation rather than from first open. The body is
  // legitimately empty here — this script seeds no content — so this mostly
  // just pins the title, but it keeps all three doc creators
  // (this, e2e/db-worker.ts, scripts/seed-sample-data.ts) producing identical
  // state. scripts/integrity/check-doc-integrity.ts is what verifies that.
  const cached = docContentFromYdoc(seed);
  seed.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);
  await prisma.doc.update({
    where: { id: doc.id },
    data: { proseJson: cached.proseJson as Prisma.InputJsonValue, title: cached.title },
  });

  console.log(`Created doc "${doc.title}" (id=${doc.id}, slug=${doc.slug}) by ${authorEmail}, visibility=${visibility}`);
  console.log(`Edit: http://localhost:3000/doc/${doc.slug}/edit`);
}

async function del(slugOrId: string) {
  const doc = await prisma.doc.findFirst({
    where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
    include: { authors: { include: { user: true } } },
  });
  if (!doc) {
    console.log(`${slugOrId} does not exist, nothing to do.`);
    return;
  }

  const unsafeAuthors = doc.authors.filter((a) => !SAFE_EMAIL.test(a.user.email));
  if (doc.authors.length === 0 || unsafeAuthors.length > 0) {
    console.error(
      `Refusing to delete "${docTitleOrFallback(doc.title)}" (id=${doc.id}) — it has ${
        doc.authors.length === 0 ? "no authors" : `a non-@example.com author (${unsafeAuthors[0].user.email})`
      }.`,
    );
    process.exitCode = 1;
    return;
  }

  // PLAN.md §13a — every annotation on this doc has its own ydoc row, with
  // no FK back to the annotation (same no-foreign-key rule as doc/ydoc
  // itself). doc.delete cascades away the Annotation rows but has no way to
  // know about their ydocs, so those ids have to be captured first or the
  // rows are unreachable garbage the instant the cascade fires.
  const annotationIds = (await prisma.annotation.findMany({ where: { docId: doc.id }, select: { id: true } })).map(
    (a) => a.id,
  );

  await prisma.doc.delete({ where: { id: doc.id } });
  await prisma.ydoc.deleteMany({
    where: { id: { in: [ydocIdForDoc(doc.id), ...annotationIds.map(ydocIdForAnnotation)] } },
  });
  console.log(
    `Deleted doc "${docTitleOrFallback(doc.title)}" (id=${doc.id}, slug=${doc.slug}), its ydoc row, and ${annotationIds.length} annotation ydoc row(s).`,
  );
}

async function main() {
  const [cmd, arg2, ...rest] = process.argv.slice(2);

  if (cmd === "create") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-doc.ts create <authorEmail> [--visibility=PRIVATE|SHARED] [title]");
      process.exitCode = 1;
      return;
    }
    if (!SAFE_EMAIL.test(arg2)) {
      console.error(`Refusing to author a doc as "${arg2}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    const { title, visibility } = parseCreateArgs(rest);
    await create(arg2, title || `Test doc ${new Date().toISOString()}`, visibility);
  } else if (cmd === "delete") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-doc.ts delete <slugOrId>");
      process.exitCode = 1;
      return;
    }
    await del(arg2);
  } else {
    console.error("Usage: npx tsx scripts/test-doc.ts <create|delete> ...");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
