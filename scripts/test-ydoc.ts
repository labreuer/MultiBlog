// Create, list, or delete throwaway documents in the standalone ydoc stack
// (PLAN.md §11) — for exercising /ydoc-debug without needing a real editing
// session first. Only ever touches ids under the ydoc:test- prefix (see
// src/lib/ydoc-names.ts); delete refuses anything else, the same containment
// convention as scripts/test-user.ts's @example.com guard.
//
// Usage:
//   npx tsx scripts/test-ydoc.ts create [--garbage]
//   npx tsx scripts/test-ydoc.ts list
//   npx tsx scripts/test-ydoc.ts delete <id>
//
// With no flags, `create` writes an empty (but TipTap-compatible) document.
// --garbage writes bytes that are not a valid Yjs update at all, to exercise
// the "this document isn't TipTap-compatible" error path deliberately rather
// than by accident.
//
// There used to be a --from-post flag seeding a test ydoc from a post's
// latest revision — posts no longer have their own editable content to seed
// from (PLAN.md §15: a post's content is a snapshot *of* a doc, not
// independently authored), so the only way to get a ydoc real content now is
// to actually edit one — scripts/test-doc.ts create, then edit it at
// /doc/<slug>/edit.

import "dotenv/config";
import * as Y from "yjs";
import { prisma } from "../src/lib/prisma";
import { newTestYdocId, isTestYdocDocument } from "../src/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";

// Not a valid Yjs update under any encoding — Y.applyUpdate throws while
// decoding it, which is what drives renderYdocBlob's catch path.
const GARBAGE_BYTES = new Uint8Array([0xff, 0x00, 0xff, 0x00, 0xff]);

function parseCreateArgs(args: string[]): { garbage: boolean } {
  return { garbage: args.includes("--garbage") };
}

async function create(args: string[]) {
  const { garbage } = parseCreateArgs(args);

  const id = newTestYdocId();
  let bytes: { ydoc: Uint8Array; stateVector: Uint8Array };
  if (garbage) {
    bytes = { ydoc: GARBAGE_BYTES, stateVector: GARBAGE_BYTES };
  } else {
    const doc = new Y.Doc();
    bytes = encodeYdocState(doc);
    doc.destroy();
  }

  await ydocStore.createIfAbsent(id, bytes.ydoc, bytes.stateVector);
  console.log(`Created ${garbage ? "garbage " : ""}ydoc ${id}.`);
  console.log(`View: http://localhost:3000/ydoc-debug`);
}

async function list() {
  const rows = await prisma.ydoc.findMany({
    where: { id: { startsWith: "ydoc:test-" } },
    orderBy: { updatedAt: "desc" },
  });
  if (rows.length === 0) {
    console.log("No test ydocs.");
    return;
  }
  for (const row of rows) {
    console.log(`${row.id}  created=${row.createdAt.toISOString()}  updated=${row.updatedAt.toISOString()}`);
  }
}

async function del(id: string) {
  if (!isTestYdocDocument(id)) {
    console.error(`Refusing to delete "${id}" — this script only touches ydoc:test- documents.`);
    process.exitCode = 1;
    return;
  }
  const existing = await prisma.ydoc.findUnique({ where: { id } });
  if (!existing) {
    console.log(`${id} does not exist, nothing to do.`);
    return;
  }
  await prisma.ydoc.delete({ where: { id } });
  console.log(`Deleted ${id}.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "create") {
    await create(rest);
  } else if (cmd === "list") {
    await list();
  } else if (cmd === "delete") {
    if (!rest[0]) {
      console.error("Usage: npx tsx scripts/test-ydoc.ts delete <id>");
      process.exitCode = 1;
      return;
    }
    await del(rest[0]);
  } else {
    console.error(
      "Usage:\n" +
        "  npx tsx scripts/test-ydoc.ts create [--garbage]\n" +
        "  npx tsx scripts/test-ydoc.ts list\n" +
        "  npx tsx scripts/test-ydoc.ts delete <id>",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
