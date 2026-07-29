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
// delete removes both the doc row and its derived ydoc:<id> row — the two
// tables have no foreign key between them (§12b), so nothing cascades this
// automatically; skipping it would leak a ydoc/ydoc_update row with no
// owning doc, which is exactly what scripts/test-ydoc.ts's own containment
// guard exists to not have to clean up (a doc's ydoc is never ydoc:test-
// prefixed).
// Delete docs before deleting their author with test-user.ts delete — once
// a doc's only author is gone, "no authors" is indistinguishable from a
// real doc that lost its author some other way, so delete refuses it.

import "dotenv/config";
import * as Y from "yjs";
import { prisma } from "../src/lib/prisma";
import { uniqueDocSlug } from "../src/lib/doc-slug";
import { ydocIdForDoc } from "../src/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";
import { DocVisibility } from "../src/generated/prisma/enums";

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

  const emptyDoc = new Y.Doc();
  const { ydoc, stateVector } = encodeYdocState(emptyDoc);
  emptyDoc.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);

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
      `Refusing to delete "${doc.title}" (id=${doc.id}) — it has ${
        doc.authors.length === 0 ? "no authors" : `a non-@example.com author (${unsafeAuthors[0].user.email})`
      }.`,
    );
    process.exitCode = 1;
    return;
  }

  await prisma.doc.delete({ where: { id: doc.id } });
  await prisma.ydoc.deleteMany({ where: { id: ydocIdForDoc(doc.id) } });
  console.log(`Deleted doc "${doc.title}" (id=${doc.id}, slug=${doc.slug}) and its ydoc row.`);
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
