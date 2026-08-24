// One-off: re-stamps every **mark-anchored** annotation with the ydoc_update
// that carries its mark, rather than the state its author was looking at.
//
// WHY
//
// `Annotation.ydocUpdateId` records a revision, and AnnotationNode's "at this
// revision" control scrubs the reading view to it. For a mark-anchored
// annotation (PLAN.md §12i — the doc editor's mechanism) that stamp was the
// state at *post* time, and the mark is applied by the collab server as an
// update strictly afterwards. So the stamp always named the one revision
// where the annotation is guaranteed *not* to be attached: clicking "at this
// revision" scrubbed to a document containing no such mark, and the card
// dropped out of the margin rail on arrival. Measured before the fix, on a
// real doc: at update 64951 (an annotation's own stamp) the document carried
// four annotation marks and not that annotation's; its mark first appears at
// 65049.
//
// Column-anchored annotations (§13o, either reading view) never had this
// problem — their offsets and quote are true *at* the stamp by construction —
// and this script does not touch them. The point is to make the stamp mean
// one thing for both mechanisms: **the earliest revision at which this
// annotation is locatable.**
//
// postAnnotation now stamps correctly going forward (§13n). This is for rows
// written before that.
//
// HOW
//
// Replays each affected doc's update log once, decoding after every update
// and noting the first row at which each annotation id appears as a mark.
// That is O(updates x decode) per doc, which is the same work /ydoc-debug's
// replay slider does for one document — fine as a one-off, not something to
// put on a request path.
//
// Deliberately conservative about what it will change:
//   - only annotations with no anchor columns (mark-anchored, or
//     document-level) — a column-anchored row's stamp is its offsets'
//     coordinate system and moving it would invalidate them;
//   - only when the mark is actually found in the log. An annotation whose
//     mark never landed (§12i's degraded path) keeps its original stamp,
//     which remains the most honest value available;
//   - only when the found row differs from what is stored, so re-running is
//     a no-op.
//
// Usage:
//   npx tsx scripts/backfill-mark-annotation-stamps.ts              # dry run
//   npx tsx scripts/backfill-mark-annotation-stamps.ts --apply
//   ... --doc=<docId>     restrict to one doc
//   ... --verbose         also print rows that need no change
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5432/frombackup_kicking \
//     npx tsx scripts/backfill-mark-annotation-stamps.ts --apply
//
// Dry run is the default, per the convention scripts/import-legacy.ts and
// scripts/etherpad/import-etherpad.ts already set: nothing here is reversible
// from the row itself, since the previous stamp is overwritten.
//
// Afterwards, `scripts/integrity/check-annotation-anchors.ts` verifies the
// result — its `mark-at-stamp` check is exactly this script's postcondition.

import "dotenv/config";
import * as Y from "yjs";
import { prisma } from "../src/lib/prisma";
import { ydocIdForDoc } from "../src/lib/ydoc-names";
import { requireDocAnnotationId } from "../src/lib/annotation-container";
import { docContentExtensions, collectMarkAttrValues } from "../src/lib/tiptap-schema";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";

const apply = process.argv.includes("--apply");
const verbose = process.argv.includes("--verbose");
const docFilter = process.argv.find((a) => a.startsWith("--doc="))?.slice(6);

function marksIn(ydoc: Y.Doc): string[] {
  try {
    const json = TiptapTransformer.extensions(docContentExtensions).fromYdoc(ydoc, "default") as JSONContent;
    return collectMarkAttrValues(json, "annotation", "id");
  } catch {
    // A document that isn't TipTap-shaped at this point in its history —
    // /ydoc-debug's --garbage fixture, or an early row mid-seeding. Nothing
    // to find, and not this script's business to complain about.
    return [];
  }
}

async function main() {
  // Mark-anchored or document-level: no anchor columns. A column-anchored row
  // is excluded here rather than filtered later, so there is no path on which
  // this script could move one.
  const candidates = await prisma.annotation.findMany({
    where: {
      anchorFrom: null,
      quotedText: "",
      // PLAN.md §19 — this backfill is about the doc-side *mark* mechanism,
      // which files have no equivalent of; a file annotation matching the two
      // null-ish conditions above is simply document-level, not un-stamped.
      docId: { not: null },
      ...(docFilter ? { docId: docFilter } : {}),
    },
    select: { id: true, docId: true, fileId: true, ydocUpdateId: true, bodyText: true },
  });

  const byDoc = new Map<string, typeof candidates>();
  for (const a of candidates) {
    const annotationDocId = requireDocAnnotationId(a, "backfill-mark-annotation-stamps");
    const group = byDoc.get(annotationDocId) ?? [];
    group.push(a);
    byDoc.set(annotationDocId, group);
  }

  console.log(
    `${candidates.length} mark-anchored/document-level annotation(s) across ${byDoc.size} doc(s)` +
      `${apply ? "" : "  [DRY RUN — pass --apply to write]"}\n`,
  );

  let restamped = 0;
  let alreadyRight = 0;
  let neverMarked = 0;

  for (const [docId, annotations] of byDoc) {
    const ydocId = ydocIdForDoc(docId);
    const rows = await prisma.ydocUpdate.findMany({
      where: { ydocId },
      orderBy: { id: "asc" },
      select: { id: true, update: true },
    });
    if (rows.length === 0) {
      neverMarked += annotations.length;
      if (verbose) console.log(`  ${docId}: no update log, skipping ${annotations.length} annotation(s)`);
      continue;
    }

    // First appearance of each id, by replaying once and decoding per step.
    // Stops early once every annotation on this doc has been located, which
    // on a long log usually saves most of the work.
    const wanted = new Set(annotations.map((a) => a.id));
    const firstSeen = new Map<string, bigint>();
    const replay = new Y.Doc();
    for (const row of rows) {
      Y.applyUpdate(replay, new Uint8Array(row.update));
      for (const id of marksIn(replay)) {
        if (wanted.has(id) && !firstSeen.has(id)) {
          firstSeen.set(id, row.id);
          wanted.delete(id);
        }
      }
      if (wanted.size === 0) break;
    }
    replay.destroy();

    for (const a of annotations) {
      const markRow = firstSeen.get(a.id);
      const label = `${a.id}  ${JSON.stringify(a.bodyText.slice(0, 32))}`;
      if (markRow === undefined) {
        neverMarked++;
        if (verbose) console.log(`  skip     ${label}  — no mark anywhere in the log (document-level)`);
        continue;
      }
      if (a.ydocUpdateId === markRow) {
        alreadyRight++;
        if (verbose) console.log(`  ok       ${label}  — already stamped ${markRow}`);
        continue;
      }
      restamped++;
      console.log(`  restamp  ${label}  ${a.ydocUpdateId ?? "null"} -> ${markRow}`);
      if (apply) {
        await prisma.annotation.update({ where: { id: a.id }, data: { ydocUpdateId: markRow } });
      }
    }
  }

  console.log(
    `\n${apply ? "re-stamped" : "would re-stamp"} ${restamped}; ` +
      `${alreadyRight} already correct; ${neverMarked} left alone (no mark in the log)`,
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
