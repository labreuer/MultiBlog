// Fill in doc.updated_by_user_id where it is NULL, deriving "who edited this
// last" from the doc's own ydoc — for rows written before the column existed
// (PLAN.md §16o), or by any path that had no user to name.
//
// Usage:
//   npx tsx scripts/doc/backfill-updated-by.ts [--dry-run] [--include-deleted]
//
// --dry-run          work out every answer and report it, write nothing.
// --include-deleted  also backfill soft-deleted docs (skipped by default).
//
// ---------------------------------------------------------------------------
// WHERE THE ANSWER COMES FROM
//
// ydoc_update has **no user column** — it is id/ydoc_id/update/created_at, raw
// Yjs bytes and a timestamp (contrast ydoc_snapshot, which does carry one). So
// attribution is a two-hop derivation, and both hops live in the ydoc itself:
//
//   1. an update's bytes encode the Yjs *clientID* that produced it, readable
//      without applying the update via Y.parseUpdateMeta(update).from;
//   2. clientID -> user id is the top-level `clients` Y.Map inside the document
//      (PLAN.md §11d), written once per client by server/ydoc-hooks.ts's
//      attributeUpdate and read back by src/lib/ydoc-render.ts.
//
// The map is part of the document state, so materializing ydoc.ydoc gives the
// whole of it — the update log only has to be consulted for *ordering*, i.e.
// which of several known clients went last. A doc whose map names exactly one
// user needs no log walk at all: that user is the only person who ever edited
// it, so they are trivially the most recent. Only a multi-author doc pays for
// the walk, newest update first, stopping at the first one whose origin
// clients resolve.
//
// ---------------------------------------------------------------------------
// WHAT IT REFUSES TO GUESS
//
// - No ydoc row, or a ydoc whose `clients` map is empty: nothing to derive
//   from. Skipped and reported, never defaulted to the doc's byline author —
//   a byline says who may edit, not who did.
// - A clients entry naming a user row that no longer exists (a hard-deleted
//   throwaway account): dropped before it can violate the foreign key. Soft-
//   deleted users are kept — the row is still there, and "last edited by
//   someone since deleted" is true.
// - Every update ambiguous or unresolvable: skipped and reported.
//
// Where the newest resolvable update names more than one user (a merged
// update carrying several origin clients), one is picked deterministically
// and the doc is counted as ambiguous in the summary. That is the same
// last-writer-wins looseness the column is defined to have — see §16o and
// schema.prisma — not a claim this script can do better than the live path.
//
// ---------------------------------------------------------------------------
// TIMESTAMPS, AND WHY THIS IS SAFE TO RUN WITH THE COLLAB SERVER UP
//
// The write is raw SQL, for two reasons. Doc.updatedAt is @updatedAt, which
// Prisma applies *client-side* to any update of the row whether or not the
// column is named — the same trap scripts/doc/collapse-blank-lines.ts has to
// undo by hand. Naming only updated_by_user_id also keeps the
// doc_sync_prose_json_length trigger out of it (it is declared BEFORE INSERT
// OR UPDATE **OF prose_json**). Backfilling who last edited a doc is not
// itself an edit, so neither timestamp moves.
//
// The UPDATE additionally carries `AND updated_by_user_id IS NULL`, making it
// a compare-and-set: if the collab server's store debounce set a real, fresher
// value between this script's read and its write, that value wins and the row
// is reported as already-filled. So unlike collapse-blank-lines.ts — which
// mutates the ydoc and would lose the race outright — this one does not
// require stopping the collab server, and does not check the port.

import "dotenv/config";
import * as Y from "yjs";
import { prisma, prismaIncludingDeleted } from "../../src/lib/prisma";
import { ydocIdForDoc } from "../../src/lib/ydoc-names";

// How many ydoc_update rows to pull per page of the newest-first walk. Only
// a multi-author doc walks at all, and the first page almost always settles
// it, so this trades a rarely-paid round trip for not loading a long log's
// worth of blobs into memory at once.
const UPDATE_PAGE = 200;

type DocRow = { id: string; title: string; slug: string; deletedAt: Date | null };

type Resolution =
  | { kind: "resolved"; userId: string; via: "sole-editor" | "latest-update"; ambiguous: boolean }
  | { kind: "skip"; reason: string };

/** clientID -> userId from the doc's own state, dropping entries whose user row is gone. */
function clientsMap(ydocBytes: Uint8Array, knownUserIds: Set<string>): Map<string, string> {
  const state = new Y.Doc();
  try {
    Y.applyUpdate(state, ydocBytes);
    const clients = new Map<string, string>();
    state.getMap<string>("clients").forEach((userId, clientId) => {
      if (typeof userId === "string" && knownUserIds.has(userId)) clients.set(clientId, userId);
    });
    return clients;
  } finally {
    state.destroy();
  }
}

/**
 * The most recent update whose origin clients are in `clients`, as a user id.
 * Walks newest-first and stops at the first update that resolves; an update
 * whose bytes don't parse is stepped over rather than aborting the doc.
 */
async function latestEditorFromLog(
  ydocId: string,
  clients: Map<string, string>,
): Promise<{ userId: string; ambiguous: boolean } | null> {
  for (let skip = 0; ; skip += UPDATE_PAGE) {
    const page = await prismaIncludingDeleted.ydocUpdate.findMany({
      where: { ydocId },
      select: { update: true },
      orderBy: { id: "desc" },
      take: UPDATE_PAGE,
      skip,
    });
    if (page.length === 0) return null;

    for (const row of page) {
      let originClientIds: IterableIterator<number>;
      try {
        originClientIds = Y.parseUpdateMeta(new Uint8Array(row.update)).from.keys();
      } catch {
        continue; // not a decodable Yjs update; the next one may be
      }
      // A Set, so several clientIDs belonging to the same person collapse to
      // one user and don't read as ambiguity.
      const users = new Set<string>();
      for (const clientId of originClientIds) {
        const userId = clients.get(String(clientId));
        if (userId) users.add(userId);
      }
      if (users.size === 0) continue;
      // Sorted so a merged update with several authors resolves the same way
      // on every run rather than following Set insertion order.
      const picked = [...users].sort()[0];
      return { userId: picked, ambiguous: users.size > 1 };
    }
  }
}

async function resolveDoc(docId: string, knownUserIds: Set<string>): Promise<Resolution> {
  const ydocId = ydocIdForDoc(docId);
  const row = await prismaIncludingDeleted.ydoc.findUnique({ where: { id: ydocId }, select: { ydoc: true } });
  if (!row) return { kind: "skip", reason: "no ydoc row" };

  let clients: Map<string, string>;
  try {
    clients = clientsMap(new Uint8Array(row.ydoc), knownUserIds);
  } catch (err) {
    return { kind: "skip", reason: `ydoc state wouldn't decode: ${err}` };
  }

  if (clients.size === 0) {
    return { kind: "skip", reason: "no usable clientID -> user attribution in the ydoc" };
  }

  const distinct = new Set(clients.values());
  if (distinct.size === 1) {
    // One person has ever edited this doc, so ordering can't change the
    // answer — no reason to read the log.
    return { kind: "resolved", userId: [...distinct][0], via: "sole-editor", ambiguous: false };
  }

  const fromLog = await latestEditorFromLog(ydocId, clients);
  if (!fromLog) {
    return { kind: "skip", reason: `${distinct.size} editors, but no update resolves to any of them` };
  }
  return { kind: "resolved", userId: fromLog.userId, via: "latest-update", ambiguous: fromLog.ambiguous };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const includeDeleted = argv.includes("--include-deleted");

  const unknown = argv.filter((a) => !["--dry-run", "--include-deleted"].includes(a));
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  // prismaIncludingDeleted, not prisma: the extended client (src/lib/prisma.ts)
  // silently ANDs `deletedByUserId: null` into every doc read, so
  // --include-deleted has to bypass it to mean anything.
  const targets: DocRow[] = await prismaIncludingDeleted.doc.findMany({
    where: {
      updatedByUserId: null,
      ...(includeDeleted ? {} : { deletedByUserId: null }),
    },
    select: { id: true, title: true, slug: true, deletedAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (targets.length === 0) {
    console.log("No docs with a NULL updated_by_user_id — nothing to do.");
    return;
  }

  // Every user id the FK could accept, soft-deleted included: the row still
  // exists, and attributing to someone since deleted is true rather than
  // convenient.
  const knownUserIds = new Set(
    (await prismaIncludingDeleted.user.findMany({ select: { id: true } })).map((u) => u.id),
  );

  console.log(
    `${dryRun ? "DRY RUN — " : ""}backfilling updated_by_user_id for ${targets.length} doc(s)` +
      `${includeDeleted ? " (including soft-deleted)" : ""}.\n`,
  );

  let filled = 0;
  let ambiguousCount = 0;
  let racedCount = 0;
  const skipped: { doc: DocRow; reason: string }[] = [];

  for (const doc of targets) {
    const label = `${doc.title || "(untitled)"} (${doc.id})`;
    const result = await resolveDoc(doc.id, knownUserIds);

    if (result.kind === "skip") {
      skipped.push({ doc, reason: result.reason });
      console.log(`SKIP  ${label} — ${result.reason}`);
      continue;
    }

    const note = `${result.via}${result.ambiguous ? ", ambiguous — picked one" : ""}`;
    if (result.ambiguous) ambiguousCount += 1;

    if (dryRun) {
      filled += 1;
      console.log(`WOULD ${label} -> ${result.userId} (${note})`);
      continue;
    }

    // Raw SQL: keeps @updatedAt and the prose_json trigger out of it, and the
    // IS NULL guard makes this a compare-and-set against a concurrent collab
    // flush. See the header.
    const affected = await prismaIncludingDeleted.$executeRaw`
      UPDATE "doc"
         SET "updated_by_user_id" = ${result.userId}
       WHERE "id" = ${doc.id}
         AND "updated_by_user_id" IS NULL`;

    if (affected === 0) {
      racedCount += 1;
      console.log(`RACED ${label} — filled by something else mid-run, left as it now stands`);
      continue;
    }
    filled += 1;
    console.log(`SET   ${label} -> ${result.userId} (${note})`);
  }

  console.log(
    `\n${dryRun ? "Would have filled" : "Filled"} ${filled} of ${targets.length} doc(s)` +
      `${ambiguousCount ? `, ${ambiguousCount} of them ambiguous` : ""}` +
      `${racedCount ? `; ${racedCount} filled concurrently and left alone` : ""}` +
      `${skipped.length ? `; ${skipped.length} skipped` : ""}.`,
  );

  if (skipped.length) {
    const byReason = new Map<string, number>();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    console.log("\nSkipped, by reason:");
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}x  ${reason}`);
    }
    console.log(
      "\nA skipped doc keeps a NULL updated_by_user_id, which /docs renders as a blank\n" +
        '"Updated by" cell and sorts last. The next real edit fills it in.',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
