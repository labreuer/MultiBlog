// Verifies that every column-anchored annotation still means what it claims —
// the one property PLAN.md §13o's whole design rests on and nothing else
// checks.
//
// An annotation anchored from a reading view stores three things (anchor_from,
// anchor_to, quoted_text) plus a version stamp (ydoc_update_id) naming the
// state they were measured against. `captureAnnotationAnchor` establishes the
// invariant at write time: replay to that stamp and `textBetween(anchor_from,
// anchor_to)` *is* `quoted_text`, by construction. Everything downstream
// assumes it — the reading views' re-resolution treats the stored quote as
// ground truth to search for, and COLLAB.md §7's eventual materialize-and-diff
// repair would take the stamped state as the `from` side of its diff.
//
// Nothing re-derives it, so a break is silent: the annotation keeps rendering,
// its quote header keeps showing text, and the anchor just resolves to the
// wrong passage or to nothing. That is what this makes loud.
//
// Scope: the *annotation* side only. Whether the ydoc it points into is itself
// internally consistent is check-ydoc-integrity.ts's job, and a bad ydoc will
// make this script report faults that evaporate once the blob is repaired — so
// run that one first, same ordering this folder's README already prescribes for
// the other pair.
//
// Usage:
//   npx tsx scripts/integrity/check-annotation-anchors.ts            # every annotation
//   npx tsx scripts/integrity/check-annotation-anchors.ts --doc=<docId>
//   npx tsx scripts/integrity/check-annotation-anchors.ts --annotation=<annotationId>
//   ... --verbose        also print annotations that pass
//
// Exits non-zero on any ERROR-level finding.
//
// WHAT IT CHECKS
//   1. stamp-present   — an anchored annotation with no ydoc_update_id has no
//      coordinate system, so its offsets name a position in no particular
//      document state. WARN, not ERROR: rows written before the stamp column
//      existed are legitimately in this state, and the offsets may still
//      resolve against the live document by luck or by text search.
//   2. stamp-exists    — the stamped id must be a real ydoc_update row *of the
//      ydoc the anchor targets*. A stamp naming another document's log is the
//      §13p root/reply confusion (doc's log vs. the parent annotation's) and
//      makes every downstream replay resolve against the wrong document.
//   3. quote-at-stamp  — the invariant itself. Replays the target ydoc to the
//      stamp and compares textBetween(anchor_from, anchor_to) to quoted_text.
//   4. mechanism-xor   — a row must be anchored by columns *or* by a mark in
//      the doc's ydoc, never both (§13o). Both would be two sources of truth
//      for one position, with nothing saying which wins.
//   5. mark-at-stamp   — the mark-anchored counterpart of check 3, and the
//      postcondition of scripts/backfill-mark-annotation-stamps.ts. An
//      annotation whose mark is in the live document must also have it at its
//      own stamp: the stamp is what "at this revision" scrubs to, and a
//      revision predating the mark shows a document the annotation is
//      provably not attached to (§13n). Only checked when the mark exists
//      *somewhere* — one that never landed is document-level, which is a
//      state the system renders rather than a fault.
//
// Cost: one replay per distinct (ydoc, stamp) pair, memoised — several
// annotations on one doc at one stamp cost one materialisation, not one each.

import "dotenv/config";
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";
import { materializeYdocAt } from "../../src/lib/ydoc-snapshot";
import { ydocIdForDoc, ydocIdForAnnotation } from "../../src/lib/ydoc-names";
import {
  annotationContentExtensions,
  docContentExtensions,
  pmAnnotationContentSchema,
  pmDocContentSchema,
  collectMarkAttrValues,
} from "../../src/lib/tiptap-schema";
import type { JSONContent } from "@tiptap/core";

type Level = "error" | "warn";
type Finding = { level: Level; annotationId: string; check: string; detail: string };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const verbose = process.argv.includes("--verbose");
const findings: Finding[] = [];
const report = (level: Level, annotationId: string, check: string, detail: string) =>
  findings.push({ level, annotationId, check, detail });

// Several annotations routinely share a doc and a stamp — a burst of replies
// posted against one state, or two readers annotating the same paragraph
// seconds apart. Replaying once per row would multiply the only expensive step
// here by the number of rows that need it least.
const materialised = new Map<string, Promise<PMNode | null>>();

function nodeAt(ydocId: string, throughUpdateId: bigint, isAnnotationBody: boolean): Promise<PMNode | null> {
  const key = `${ydocId}@${throughUpdateId}`;
  const hit = materialised.get(key);
  if (hit) return hit;

  const pending = (async () => {
    let ydoc: Y.Doc | null = null;
    try {
      ydoc = await materializeYdocAt(ydocId, throughUpdateId);
      const extensions = isAnnotationBody ? annotationContentExtensions : docContentExtensions;
      const schema = isAnnotationBody ? pmAnnotationContentSchema : pmDocContentSchema;
      return schema.nodeFromJSON(TiptapTransformer.extensions(extensions).fromYdoc(ydoc, "default"));
    } catch {
      return null;
    } finally {
      ydoc?.destroy();
    }
  })();

  materialised.set(key, pending);
  return pending;
}

async function main() {
  const docId = arg("doc");
  const annotationId = arg("annotation");

  const annotations = await prisma.annotation.findMany({
    where: {
      ...(docId ? { docId } : {}),
      ...(annotationId ? { id: annotationId } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      docId: true,
      parentAnnotationId: true,
      anchorFrom: true,
      anchorTo: true,
      quotedText: true,
      ydocUpdateId: true,
      status: true,
    },
  });

  // Which annotation ids still carry a mark, per doc — the other half of
  // check 4. Read from Doc.prose_json, which is what every render path uses
  // to make the same determination (§12h).
  const markedByDoc = new Map<string, Set<string>>();
  async function markedIn(id: string): Promise<Set<string>> {
    const hit = markedByDoc.get(id);
    if (hit) return hit;
    const doc = await prisma.doc.findUnique({ where: { id }, select: { proseJson: true } });
    const marks = new Set(
      doc?.proseJson ? collectMarkAttrValues(doc.proseJson as JSONContent, "annotation", "id") : [],
    );
    markedByDoc.set(id, marks);
    return marks;
  }

  let checked = 0;

  for (const a of annotations) {
    const anchored = a.anchorFrom !== null && a.anchorTo !== null && a.quotedText !== "";
    const marked = (await markedIn(a.docId)).has(a.id);

    if (anchored && marked) {
      report("error", a.id, "mechanism-xor", "has both stored offsets and a mark in the doc's ydoc");
    }

    // Check 5. Independent of the column checks below, and deliberately not
    // gated on `anchored` — this is the other mechanism's version of the same
    // question.
    if (!anchored && marked && a.ydocUpdateId !== null) {
      checked++;
      const node = await nodeAt(ydocIdForDoc(a.docId), a.ydocUpdateId, false);
      if (!node) {
        report("error", a.id, "mark-at-stamp", `couldn't replay the doc to ${a.ydocUpdateId}`);
      } else {
        const atStamp = collectMarkAttrValues(
          JSON.parse(JSON.stringify(node.toJSON())) as JSONContent,
          "annotation",
          "id",
        );
        if (!atStamp.includes(a.id)) {
          report(
            "error",
            a.id,
            "mark-at-stamp",
            `its mark is in the live doc but not at its stamp (${a.ydocUpdateId}) — ` +
              `"at this revision" would scrub to a document it isn't attached to; ` +
              `run scripts/backfill-mark-annotation-stamps.ts`,
          );
        } else if (verbose) {
          console.log(`  ok  ${a.id}  mark present at its stamp ${a.ydocUpdateId}`);
        }
      }
    }

    if (!anchored) continue;
    checked++;

    if (a.ydocUpdateId === null) {
      report("warn", a.id, "stamp-present", "anchored by columns but no ydoc_update_id to resolve them against");
      continue;
    }

    // §13p — a reply's offsets are into the annotation it answers, a root's
    // into the doc. Which ydoc that is decides both the replay target and the
    // schema it has to be decoded with.
    const isReply = a.parentAnnotationId !== null;
    const targetYdocId = isReply ? ydocIdForAnnotation(a.parentAnnotationId!) : ydocIdForDoc(a.docId);

    const stamp = await prisma.ydocUpdate.findUnique({
      where: { id: a.ydocUpdateId },
      select: { ydocId: true },
    });
    if (!stamp) {
      report("error", a.id, "stamp-exists", `ydoc_update ${a.ydocUpdateId} does not exist`);
      continue;
    }
    if (stamp.ydocId !== targetYdocId) {
      report(
        "error",
        a.id,
        "stamp-exists",
        `stamped against ${stamp.ydocId} but its anchor targets ${targetYdocId}`,
      );
      continue;
    }

    const node = await nodeAt(targetYdocId, a.ydocUpdateId, isReply);
    if (!node) {
      report("error", a.id, "quote-at-stamp", `couldn't replay ${targetYdocId} to ${a.ydocUpdateId}`);
      continue;
    }

    if (a.anchorTo! > node.content.size) {
      report(
        "error",
        a.id,
        "quote-at-stamp",
        `anchor [${a.anchorFrom}, ${a.anchorTo}) runs past the document's size (${node.content.size}) at that stamp`,
      );
      continue;
    }

    const actual = node.textBetween(a.anchorFrom!, a.anchorTo!, " ");
    if (actual !== a.quotedText) {
      report(
        "error",
        a.id,
        "quote-at-stamp",
        `stored ${JSON.stringify(a.quotedText)} but the document at that stamp reads ${JSON.stringify(actual)}`,
      );
    } else if (verbose) {
      console.log(`  ok  ${a.id}  ${JSON.stringify(a.quotedText.slice(0, 40))} @ ${a.ydocUpdateId}`);
    }
  }

  const errors = findings.filter((f) => f.level === "error");
  const warns = findings.filter((f) => f.level === "warn");

  console.log(
    `\nchecked ${checked} anchored annotation(s) of ${annotations.length} total — ` +
      `${errors.length} error(s), ${warns.length} warning(s)`,
  );
  for (const f of [...errors, ...warns]) {
    console.log(`  ${f.level.toUpperCase().padEnd(5)} ${f.annotationId}  ${f.check}: ${f.detail}`);
  }

  await prisma.$disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
