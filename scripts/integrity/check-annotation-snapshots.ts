// Verifies PLAN.md §22e's arrangement: that an annotation's cache columns are
// its newest *settled* state, and that its settled states — the
// `ydoc_snapshot` rows on the body's own ydoc — form an honest sequence.
//
// The doc-side sibling of check-comment-revisions.ts. A comment's cache and
// its newest revision are written in one transaction, and so are an
// annotation's cache and its newest snapshot (the settle transaction writes
// both from one decoded document) — so a divergence here is a fault too,
// never a legitimate lag. What can still produce one is a body whose ydoc was
// written to by something other than a settle while no session was open (a
// `/admin/annotation-replace` call that was not a Cancel, a script), or a
// restore from a dump taken between the two writes.
//
// What each check asks:
//
//   - **posted-snapshot** — every non-DRAFT annotation has `posted_at` and at
//     least one snapshot (version 1 *is* the DRAFT -> LIVE transition, and
//     `posted_at` is what the grace window is measured from); no DRAFT has
//     either.
//   - **monotone** — the snapshots' marks strictly increase, and their
//     `created_at` never goes backwards along them. §22b's rule pairs each
//     version with its successor's timestamp, so a pair out of order turns a
//     visible edit silent or the reverse; two snapshots at one mark would be
//     two versions of one state.
//   - **settled-cache** — does `body_text` match the newest snapshot's decoded
//     text, for an annotation with *no session open*? While `editing_since`
//     is set the cache is deliberately frozen behind the ydoc, so those rows
//     are skipped rather than reported. A finding means the body moved
//     without a version being recorded: the repair is to open and close an
//     edit session on it, which settles what is there now.
//   - **stale-session** — `editing_since` older than the staleness window,
//     reported as a WARN. Not a fault: an author closed a tab, and the card
//     offers Resume or Discard. Worth surfacing because the cache stays
//     frozen until someone does one of those.
//
// Whether each snapshot's *bytes* are right — equal to a replay of the log to
// its mark — is check-ydoc-integrity.ts's check 4, which already covers every
// ydoc; it is not repeated here. Run this one after it, for the reason
// README.md gives about its neighbours: a corrupt log or snapshot makes this
// report cache faults that are really one ydoc fault wearing several hats.
//
// Usage:
//   npx tsx scripts/integrity/check-annotation-snapshots.ts
//   ... --doc <id>       only annotations on one doc
//   ... --verbose        also print each annotation that passed
//
// Exits non-zero on an ERROR-level finding; a WARN alone exits zero.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";
import { decodeAnnotationSnapshot } from "../../src/lib/annotation-body";
import { STALE_EDIT_SESSION_MS } from "../../src/lib/edit-grace";
import { ydocIdForAnnotation } from "../../src/lib/ydoc-names";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const docIndex = args.indexOf("--doc");
const docId = docIndex >= 0 ? args[docIndex + 1] : null;

type Finding = { annotationId: string; level: "ERROR" | "WARN"; check: string; detail: string };

async function main() {
  const annotations = await prisma.annotation.findMany({
    where: docId ? { docId } : {},
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      bodyText: true,
      postedAt: true,
      editingSince: true,
      editedAt: true,
    },
  });

  const findings: Finding[] = [];

  for (const annotation of annotations) {
    const snapshots = await prisma.ydocSnapshot.findMany({
      where: { ydocId: ydocIdForAnnotation(annotation.id) },
      orderBy: { lastYdocUpdateId: "asc" },
      select: { id: true, lastYdocUpdateId: true, createdAt: true, ydoc: true },
    });
    const isDraft = annotation.status === "DRAFT";

    if (isDraft && (snapshots.length > 0 || annotation.postedAt !== null)) {
      findings.push({
        annotationId: annotation.id,
        level: "ERROR",
        check: "posted-snapshot",
        detail:
          `a DRAFT has ${snapshots.length} snapshot(s) and posted_at ${annotation.postedAt?.toISOString() ?? "null"} — ` +
          `version 1 is the DRAFT -> LIVE transition`,
      });
    }
    if (!isDraft && snapshots.length === 0) {
      findings.push({
        annotationId: annotation.id,
        level: "ERROR",
        check: "posted-snapshot",
        detail: `${annotation.status} with no snapshot — nothing records what readers were first shown`,
      });
    }
    if (!isDraft && annotation.postedAt === null) {
      findings.push({
        annotationId: annotation.id,
        level: "ERROR",
        check: "posted-snapshot",
        detail: `${annotation.status} with no posted_at — the grace window has nothing to measure from`,
      });
    }

    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const cur = snapshots[i];
      if (cur.lastYdocUpdateId <= prev.lastYdocUpdateId) {
        findings.push({
          annotationId: annotation.id,
          level: "ERROR",
          check: "monotone",
          detail: `snapshots ${prev.id} and ${cur.id} share mark ${cur.lastYdocUpdateId} — two versions of one state`,
        });
      }
      if (cur.createdAt.getTime() < prev.createdAt.getTime()) {
        findings.push({
          annotationId: annotation.id,
          level: "ERROR",
          check: "monotone",
          detail:
            `snapshot ${cur.id} (mark ${cur.lastYdocUpdateId}) was created before ${prev.id} ` +
            `(mark ${prev.lastYdocUpdateId}) — the window pairs versions by timestamp in mark order`,
        });
      }
    }

    const newest = snapshots[snapshots.length - 1];
    if (newest && annotation.editingSince === null) {
      try {
        // Decoded with the same function the cache writer uses, so the
        // comparison measures the body and not the decoders.
        const { bodyText } = decodeAnnotationSnapshot(new Uint8Array(newest.ydoc));
        if (bodyText !== annotation.bodyText) {
          findings.push({
            annotationId: annotation.id,
            level: "ERROR",
            check: "settled-cache",
            detail:
              `the cache is not the newest version (mark ${newest.lastYdocUpdateId}) and no session is open — ` +
              `cache ${JSON.stringify(annotation.bodyText.slice(0, 60))} vs. ` +
              `version ${JSON.stringify(bodyText.slice(0, 60))}. ` +
              `Repair: open and close an edit session to settle the current text as a version.`,
          });
        }
      } catch (err) {
        findings.push({
          annotationId: annotation.id,
          level: "ERROR",
          check: "settled-cache",
          detail: `the newest snapshot ${newest.id} could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (annotation.editingSince !== null && Date.now() - annotation.editingSince.getTime() > STALE_EDIT_SESSION_MS) {
      findings.push({
        annotationId: annotation.id,
        level: "WARN",
        check: "stale-session",
        detail:
          `editing_since has been set since ${annotation.editingSince.toISOString()} — the cache stays frozen ` +
          `until someone resumes or discards it on the card`,
      });
    }

    if (verbose && !findings.some((f) => f.annotationId === annotation.id)) {
      console.log(`  ok    ${annotation.id} — ${snapshots.length} version(s)`);
    }
  }

  const errors = findings.filter((f) => f.level === "ERROR");
  console.log(
    `\n${annotations.length} annotation(s) checked — ${errors.length} error(s), ` +
      `${findings.length - errors.length} warning(s)`,
  );
  for (const finding of findings) {
    console.log(`  ${finding.level} ${finding.annotationId} [${finding.check}]\n          ${finding.detail}`);
  }

  await prisma.$disconnect();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
