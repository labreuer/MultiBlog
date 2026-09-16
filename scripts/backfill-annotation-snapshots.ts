// One-off: gives every posted annotation body its version 1 as a
// `ydoc_snapshot`, and converts the rows of a still-present
// `annotation_revision` table into snapshots before that table is dropped.
//
// WHY
//
// PLAN.md §22e records an annotation body's versions as snapshots on the
// body's own ydoc — one at DRAFT -> LIVE, one per Done that changed anything —
// and nothing else: no text copy, no revision table. That leaves two kinds of
// row with no version 1:
//
//   - Every annotation posted before versions existed. Its first version is
//     the body as it stands, exactly, because nothing has edited a posted body
//     before now — the same fact the `posted_at` backfill in
//     `add_annotation_edit_sessions` rests on.
//   - On the two dev databases only: annotations whose versions were written
//     into `annotation_revision` by an earlier build of the same feature. Each
//     of those rows is a version (a mark in the body's own log, who settled it,
//     when), and is converted into the snapshot it would have been.
//
// HOW
//
// Where `annotation_revision` still exists — read through raw SQL, since the
// Prisma model is gone — every revision row becomes a snapshot on the
// annotation's ydoc at `ydoc_update_id` (its own log's tail if the stamp is
// null, which the old schema allowed and nothing ever wrote), materialised
// from the log and encoded the way `ydoc_snapshot` stores it, with `user_id`
// = `author_user_id` and `created_at` = the revision's. `posted_at`, if still
// null, becomes revision 1's `created_at`, which is the exact DRAFT -> LIVE
// moment for rows posted under that build.
//
// Everywhere: every non-DRAFT annotation whose ydoc has no snapshot at all
// gets one at the log's tail, `user_id` = the annotation's author,
// `created_at` = `posted_at` (falling back to `created_at`, and setting
// `posted_at` from it if the migration's backfill has not run).
//
// Reported and never touched: a snapshot on an annotation ydoc that matches no
// revision row while the table still exists — somebody pressed Snapshot on
// /ydoc-debug. Those become versions the moment the code lands; whether to
// delete them is a human call.
//
// Idempotent: a mark that already has a snapshot is skipped, so re-running is
// a no-op. Dry run is the default, per the convention
// scripts/backfill-mark-annotation-stamps.ts and the importers set.
//
// Usage:
//   npx tsx scripts/backfill-annotation-snapshots.ts              # dry run
//   npx tsx scripts/backfill-annotation-snapshots.ts --apply
//   ... --verbose         also print rows that need no change
//
// Order, on a dev database that still has the table (PLAN.md §22e's
// migration notes): add `posted_at` by hand, run this with --apply, then drop
// the table and repair the migration checksum. In production the table never
// existed: `prisma migrate deploy`, then this.
//
// Afterwards, `scripts/integrity/check-ydoc-integrity.ts` (check 4: every
// snapshot equals a replay to its mark) and
// `scripts/integrity/check-annotation-snapshots.ts` (`posted-snapshot`,
// `settled-cache`) verify the result.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../src/lib/prisma";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";
import { materializeYdocAt } from "../src/lib/ydoc-snapshot";
import { ydocIdForAnnotation, YDOC_ANNOTATION_PREFIX } from "../src/lib/ydoc-names";

const apply = process.argv.includes("--apply");
const verbose = process.argv.includes("--verbose");

type RevisionRow = {
  id: string;
  annotation_id: string;
  revision_no: number;
  ydoc_update_id: bigint | null;
  author_user_id: string;
  created_at: Date;
};

async function snapshotAt(ydocId: string, mark: bigint, userId: string | null, createdAt: Date): Promise<void> {
  const doc = await materializeYdocAt(ydocId, mark);
  try {
    const { ydoc, stateVector } = encodeYdocState(doc);
    await prisma.ydocSnapshot.create({
      data: {
        ydocId,
        ydoc: Buffer.from(ydoc),
        stateVector: Buffer.from(stateVector),
        lastYdocUpdateId: mark,
        userId,
        createdAt,
      },
    });
  } finally {
    doc.destroy();
  }
}

async function main() {
  console.log(apply ? "Applying." : "Dry run — pass --apply to write.");

  const [{ exists: hasRevisionTable }] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('public.annotation_revision') IS NOT NULL AS exists`;

  let created = 0;
  let skipped = 0;
  const convertedMarks = new Map<string, Set<bigint>>();

  if (hasRevisionTable) {
    const revisions = await prisma.$queryRaw<RevisionRow[]>`
      SELECT id, annotation_id, revision_no, ydoc_update_id, author_user_id, created_at
      FROM annotation_revision ORDER BY annotation_id, revision_no`;
    console.log(`\nannotation_revision is present: ${revisions.length} row(s) to convert`);
    for (const revision of revisions) {
      const ydocId = ydocIdForAnnotation(revision.annotation_id);
      const mark = revision.ydoc_update_id ?? (await ydocStore.maxUpdateId(ydocId));
      const label = `${revision.annotation_id} r${revision.revision_no}`;
      if (mark === null) {
        console.log(`  skip     ${label}  — no update log for ${ydocId}`);
        skipped += 1;
        continue;
      }
      const marks = convertedMarks.get(ydocId) ?? new Set<bigint>();
      marks.add(mark);
      convertedMarks.set(ydocId, marks);

      if (revision.revision_no === 1) {
        const annotation = await prisma.annotation.findUnique({
          where: { id: revision.annotation_id },
          select: { postedAt: true },
        });
        if (annotation && annotation.postedAt === null) {
          if (verbose || !apply) console.log(`  posted   ${label}  — posted_at := ${revision.created_at.toISOString()}`);
          if (apply) {
            await prisma.annotation.update({
              where: { id: revision.annotation_id },
              data: { postedAt: revision.created_at },
            });
          }
        }
      }

      if (await ydocStore.findSnapshotAtMark(ydocId, mark)) {
        if (verbose) console.log(`  ok       ${label}  — snapshot at ${mark} exists`);
        skipped += 1;
        continue;
      }
      console.log(`  create   ${label}  — snapshot at ${mark}, by ${revision.author_user_id}, ${revision.created_at.toISOString()}`);
      if (apply) await snapshotAt(ydocId, mark, revision.author_user_id, revision.created_at);
      created += 1;
    }
  } else {
    console.log("\nannotation_revision is not present; nothing to convert.");
  }

  const posted = await prisma.annotation.findMany({
    where: { status: { not: "DRAFT" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true, postedAt: true, createdAt: true },
  });
  console.log(`\n${posted.length} posted annotation(s); giving version 1 to any whose ydoc has no snapshot`);
  for (const annotation of posted) {
    const ydocId = ydocIdForAnnotation(annotation.id);
    const existing = await prisma.ydocSnapshot.count({ where: { ydocId } });
    if (existing > 0) {
      if (verbose) console.log(`  ok       ${annotation.id}  — ${existing} snapshot(s)`);
      continue;
    }
    const mark = await ydocStore.maxUpdateId(ydocId);
    if (mark === null) {
      console.log(`  skip     ${annotation.id}  — no update log for ${ydocId}`);
      skipped += 1;
      continue;
    }
    const at = annotation.postedAt ?? annotation.createdAt;
    console.log(`  create   ${annotation.id}  — version 1 at ${mark}, ${at.toISOString()}` + (annotation.postedAt ? "" : " (and posted_at from created_at)"));
    if (apply) {
      await snapshotAt(ydocId, mark, annotation.userId, at);
      if (annotation.postedAt === null) {
        await prisma.annotation.update({ where: { id: annotation.id }, data: { postedAt: at } });
      }
    }
    created += 1;
  }

  if (hasRevisionTable) {
    const strays = (
      await prisma.ydocSnapshot.findMany({
        where: { ydocId: { startsWith: YDOC_ANNOTATION_PREFIX } },
        select: { id: true, ydocId: true, lastYdocUpdateId: true, createdAt: true },
      })
    ).filter((s) => !convertedMarks.get(s.ydocId)?.has(s.lastYdocUpdateId));
    if (strays.length > 0) {
      console.log(`\n${strays.length} snapshot(s) on annotation ydocs match no revision row — a /ydoc-debug Snapshot, most likely. Left alone; they will list as versions:`);
      for (const s of strays) console.log(`  ${s.ydocId} at ${s.lastYdocUpdateId} (${s.createdAt.toISOString()})`);
    }
  }

  console.log(`\n${created} snapshot(s) ${apply ? "created" : "would be created"}, ${skipped} skipped.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
