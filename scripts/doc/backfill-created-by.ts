// Fill in doc.created_by_user_id where it is NULL — the docs that predate the
// column, which every create path has set since (docs/DOCS.md "Who created a
// doc"). Files need no script: migration add_doc_file_created_by fills theirs
// from `file_owner` in SQL.
//
// Usage:
//   npx tsx scripts/doc/backfill-created-by.ts            # dry run
//   npx tsx scripts/doc/backfill-created-by.ts --apply
//
// Dry run is the default, per the convention
// scripts/backfill-annotation-snapshots.ts and the importers set. Soft-deleted
// docs are included: a restored doc should name its creator like any other.
//
// ---------------------------------------------------------------------------
// WHERE THE ANSWER COMES FROM
//
// 1. **The first user in the ydoc's `clients` map.** That map (PLAN.md §11d,
//    docs/COLLAB.md "Attribution") gets a `clientID -> userId` entry from
//    server/ydoc-hooks.ts's attributeUpdate the first time a client changes the
//    doc, so its first entry is the first person who edited it. "First" is a
//    question about order, which the stored state can't answer — a Y.Map keeps
//    no insertion order across clients — so the doc is rebuilt by replaying
//    its `ydoc_update` log from row 1 (a full state, §11b invariant 1), one row
//    at a time, stopping at the first row after which the map names anyone.
//    The `ydoc` row isn't a shortcut: it can trail the log by a store
//    debounce, so an empty map there doesn't mean an empty map.
//
// 2. **Else the first `doc_author` by `byline_order`** — for a doc nobody has
//    edited since it was seeded (`+ New doc` left blank, the Markdown import,
//    import-claude-chats.ts, the seed scripts). Every create path puts its
//    creator at byline position 0, so this is the creator unless the byline
//    was edited since. import-claude-chats.ts is the known exception: it
//    rewrites the byline to its fixed order, so its docs get that order's
//    first name rather than the importing account.
//
// 3. **Else NULL**, reported.
//
// WHAT IT REFUSES TO GUESS
//
// - A first author whose user row is gone (a hard-deleted account) leaves the
//   doc NULL — what the column's ON DELETE SET NULL would have left had it
//   existed then — rather than crediting whoever edited second.
// - A log that won't replay leaves the doc NULL; the byline is the answer
//   for a doc nobody edited, not for one whose history can't be read.
// - Several users appearing in the same row (a merged update; no writer
//   produces one today) is resolved by byline order, then user id, and
//   counted as ambiguous in the summary.
//
// ---------------------------------------------------------------------------
// SAFE WITH THE COLLAB SERVER UP
//
// The write is raw SQL naming only this column, as
// scripts/doc/backfill-updated-by.ts's is: Prisma would move the @updatedAt
// `updated_at` on any update of the row, and neither column the doc's
// row-level triggers watch is touched. Its `AND created_by_user_id IS NULL`
// makes it a compare-and-set, so a re-run is a no-op and nothing a create
// path wrote is ever overwritten.

import "dotenv/config";
import * as Y from "yjs";
import { prisma, prismaIncludingDeleted } from "../../src/lib/prisma";
import { ydocIdForDoc } from "../../src/lib/ydoc-names";

// Rows per page of the oldest-first replay. Most docs settle in the first
// page; a never-edited one replays its whole log to prove it.
const UPDATE_PAGE = 500;

type Source = "ydoc" | "byline";
type Resolution =
  | { kind: "resolved"; userId: string; source: Source; ambiguous: boolean }
  | { kind: "none"; reason: string };

/** The users the `clients` map first names, replaying the log oldest-first; [] if it never names anyone. */
async function firstClientsUsers(ydocId: string): Promise<string[]> {
  const state = new Y.Doc();
  try {
    const clients = state.getMap<string>("clients");
    let after: bigint | undefined;
    for (;;) {
      const page = await prismaIncludingDeleted.ydocUpdate.findMany({
        where: { ydocId, ...(after === undefined ? {} : { id: { gt: after } }) },
        select: { id: true, update: true },
        orderBy: { id: "asc" },
        take: UPDATE_PAGE,
      });
      if (page.length === 0) return [];
      for (const row of page) {
        Y.applyUpdate(state, new Uint8Array(row.update));
        if (clients.size > 0) {
          return [...new Set([...clients.values()].filter((v): v is string => typeof v === "string"))];
        }
      }
      after = page[page.length - 1].id;
    }
  } finally {
    state.destroy();
  }
}

async function resolveDoc(byline: string[], docId: string, knownUserIds: Set<string>): Promise<Resolution> {
  let firstUsers: string[];
  try {
    firstUsers = await firstClientsUsers(ydocIdForDoc(docId));
  } catch (err) {
    return { kind: "none", reason: `the update log wouldn't replay: ${err}` };
  }

  if (firstUsers.length > 0) {
    // Sorted only to break a tie: a lone user is unaffected.
    const rank = (u: string) => (byline.includes(u) ? byline.indexOf(u) : byline.length);
    const [userId] = firstUsers.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (!knownUserIds.has(userId)) {
      return { kind: "none", reason: `first author ${userId} no longer exists` };
    }
    return { kind: "resolved", userId, source: "ydoc", ambiguous: firstUsers.length > 1 };
  }

  if (byline.length > 0) {
    return { kind: "resolved", userId: byline[0], source: "byline", ambiguous: false };
  }
  return { kind: "none", reason: "nobody in the clients map and nobody on the byline" };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const unknown = argv.filter((a) => a !== "--apply");
  if (unknown.length) {
    console.error(`Unknown argument(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  // prismaIncludingDeleted: the extended client hides soft-deleted docs.
  const targets = await prismaIncludingDeleted.doc.findMany({
    where: { createdByUserId: null },
    select: {
      id: true,
      title: true,
      deletedAt: true,
      authors: { select: { userId: true }, orderBy: [{ bylineOrder: "asc" }, { userId: "asc" }] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (targets.length === 0) {
    console.log("No docs with a NULL created_by_user_id — nothing to do.");
    return;
  }

  // Soft-deleted users included: their row exists, and the FK accepts them.
  const users = await prismaIncludingDeleted.user.findMany({ select: { id: true, email: true } });
  const emailOf = new Map(users.map((u) => [u.id, u.email]));
  const knownUserIds = new Set(emailOf.keys());

  console.log(`${apply ? "" : "DRY RUN — "}backfilling created_by_user_id for ${targets.length} doc(s).\n`);

  const counts = { ydoc: 0, byline: 0, ambiguous: 0, raced: 0, none: 0 };
  for (const doc of targets) {
    const label = `${doc.title || "(untitled)"} (${doc.id})${doc.deletedAt ? " [deleted]" : ""}`;
    const byline = doc.authors.map((a) => a.userId);
    const result = await resolveDoc(byline, doc.id, knownUserIds);

    if (result.kind === "none") {
      counts.none += 1;
      console.log(`NONE  ${label} — ${result.reason}`);
      continue;
    }

    const note = `${result.source}${result.ambiguous ? ", ambiguous" : ""}`;
    const who = `${emailOf.get(result.userId)} (${note})`;
    if (apply) {
      const affected = await prismaIncludingDeleted.$executeRaw`
        UPDATE "doc"
           SET "created_by_user_id" = ${result.userId}
         WHERE "id" = ${doc.id}
           AND "created_by_user_id" IS NULL`;
      if (affected === 0) {
        counts.raced += 1;
        console.log(`RACED ${label} — filled by something else mid-run, left as it stands`);
        continue;
      }
    }
    counts[result.source] += 1;
    if (result.ambiguous) counts.ambiguous += 1;
    console.log(`${apply ? "SET  " : "WOULD"} ${label} -> ${who}`);
  }

  console.log(
    `\n${apply ? "Filled" : "Would fill"} ${counts.ydoc + counts.byline} of ${targets.length}: ` +
      `${counts.ydoc} from the clients map${counts.ambiguous ? ` (${counts.ambiguous} ambiguous)` : ""}, ` +
      `${counts.byline} from the byline` +
      `${counts.raced ? `; ${counts.raced} filled concurrently` : ""}` +
      `${counts.none ? `; ${counts.none} left NULL` : ""}.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
