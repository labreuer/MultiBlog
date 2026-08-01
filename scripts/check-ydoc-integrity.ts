// Verifies that every ydoc's stored blob still agrees with its own update log
// — the class of corruption that the legacy import surfaced, where `ydoc.ydoc`
// said one thing and replaying `ydoc_update` said another. A live editing
// session reads the blob; /ydoc-debug's replay slider, its title-history panel,
// and any rebuild-from-log path read the log. When those two disagree the app
// shows one document and its own history shows a different one, indefinitely,
// with nothing failing loudly to say so.
//
// Usage:
//   npx tsx scripts/check-ydoc-integrity.ts                      # every ydoc
//   npx tsx scripts/check-ydoc-integrity.ts --doc=<docId>
//   npx tsx scripts/check-ydoc-integrity.ts --annotation=<annotationId>
//   npx tsx scripts/check-ydoc-integrity.ts --ydoc=<ydoc:...>
//   ... --verbose        also print documents that pass
//
// The three id flags are conveniences for the same underlying row: a doc's
// ydoc is `ydoc:<docId>` and an annotation's is `ydoc:annotation:<id>`
// (src/lib/ydoc-names.ts), so --ydoc always works if you already have the
// prefixed name. Exactly one may be given; with none, every ydoc is checked.
//
// Exits non-zero if any ERROR-level finding is reported, so it can gate a
// deploy or run from cron. WARN-level findings do not affect the exit code.
//
// WHAT IT CHECKS
//   1. log-not-empty  — a ydoc row with no ydoc_update rows has nothing to
//      rebuild from. §11b's whole recovery story is the log (CLAUDE.md is
//      explicit that a doc's ydoc row IS the doc, with the log as the only way
//      back), so an empty one is a silent loss of that.
//   2. invariant-1    — row #1 must be a full state, not a delta (§11b). Tested
//      by applying it to an empty Y.Doc and checking nothing is left pending:
//      a delta whose referents are missing parks structs in `pendingStructs`
//      rather than failing, so replay from row 1 would silently start from an
//      incomplete document.
//   3. blob-vs-log    — the main one. Replays the whole log and compares state
//      vector, body fragment, and title fragment against the stored blob.
//      Compared decoded rather than byte-for-byte: two encodings of the same
//      document differ in bytes routinely, so a byte check would be all false
//      positives.
//   4. snapshots      — each ydoc_snapshot must equal a replay of the log up to
//      its own last_ydoc_update_id (§11b invariant 2). A wrong snapshot is
//      worse than no snapshot: the replay slider rebuilds *from* it, so it
//      silently corrupts every position at or after its mark.
//   5. title-cache    — docs only. server/doc-cache.ts writes the ydoc's title
//      fragment through to Doc.title on every store debounce, deliberately
//      including the empty case (§12n). So a ydoc with no title fragment and a
//      non-empty Doc.title is a title scheduled for deletion the next time
//      anyone opens the doc — reported as a WARN, since nothing is corrupt yet.
//
// Cost: this replays every update of every document it checks, which is the
// same work /ydoc-debug does for one document, times however many it covers.
// Fine for a nightly or a pre/post-migration check; pass an id for a fast one.

import "dotenv/config";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prismaIncludingDeleted as prisma } from "../src/lib/prisma";
import { ydocIdForDoc, ydocIdForAnnotation, docIdFromYdocId } from "../src/lib/ydoc-names";
import { titleAuthorHighlightExtensions } from "../src/lib/tiptap-schema";
import { extractText } from "../src/lib/diff";

type Level = "error" | "warn";
type Finding = { level: Level; ydocId: string; check: string; detail: string };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** The three things worth comparing between a blob and a replay. */
type Decoded = { sv: string; body: string; title: string };

function decode(update: Uint8Array): Decoded {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, update);
    return {
      sv: Buffer.from(Y.encodeStateVector(d)).toString("base64"),
      body: d.getXmlFragment("default").toString(),
      title: d.getXmlFragment("title").toString(),
    };
  } finally {
    d.destroy();
  }
}

function decodeDoc(doc: Y.Doc): Decoded {
  return {
    sv: Buffer.from(Y.encodeStateVector(doc)).toString("base64"),
    body: doc.getXmlFragment("default").toString(),
    title: doc.getXmlFragment("title").toString(),
  };
}

/** Whether `update` stands on its own, or parks structs waiting for referents. */
function isSelfSufficient(update: Uint8Array): boolean {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, update);
    // `pendingStructs` is where Yjs parks structs whose dependencies haven't
    // arrived. Not part of the documented surface, hence the guarded read —
    // but it is the only signal that distinguishes "applied" from "accepted
    // and silently deferred", which is exactly the invariant-1 question.
    const store = (d as unknown as { store?: { pendingStructs?: unknown } }).store;
    return store?.pendingStructs == null;
  } finally {
    d.destroy();
  }
}

/** Short, readable rendering of a title fragment's text. */
function titleTextOf(doc: Y.Doc): string | null {
  if (doc.getXmlFragment("title").length === 0) return null;
  try {
    return extractText(TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title"));
  } catch {
    return null;
  }
}

function truncate(s: string, n = 80): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length} chars)`;
}

async function main() {
  const docId = arg("doc");
  const annotationId = arg("annotation");
  const ydocArg = arg("ydoc");
  const verbose = process.argv.includes("--verbose");

  const given = [docId, annotationId, ydocArg].filter(Boolean);
  if (given.length > 1) fail("Pass at most one of --doc=, --annotation=, --ydoc=.");

  const targetId = docId ? ydocIdForDoc(docId) : annotationId ? ydocIdForAnnotation(annotationId) : ydocArg;

  const ydocs = await prisma.ydoc.findMany({
    where: targetId ? { id: targetId } : undefined,
    orderBy: { id: "asc" },
    select: { id: true, ydoc: true, stateVector: true },
  });

  if (ydocs.length === 0) {
    if (targetId) {
      // Not a failure: a doc created but never opened has no ydoc row yet —
      // ydocOnLoadDocument creates it on first connect (CLAUDE.md).
      console.log(`\nNo ydoc row for ${targetId}. (Never opened, or the id is wrong.)\n`);
      return 0;
    }
    console.log("\nNo ydoc rows at all.\n");
    return 0;
  }

  console.log(`\nChecking ${ydocs.length} ydoc(s)...\n`);

  const findings: Finding[] = [];
  let passed = 0;

  for (const row of ydocs) {
    const before = findings.length;
    const blob = new Uint8Array(row.ydoc);

    const updates = await prisma.ydocUpdate.findMany({
      where: { ydocId: row.id },
      orderBy: { id: "asc" },
      select: { id: true, update: true },
    });

    // --- 1. log-not-empty -------------------------------------------------
    if (updates.length === 0) {
      findings.push({
        level: "error",
        ydocId: row.id,
        check: "log-not-empty",
        detail: "ydoc row exists but ydoc_update has no rows — nothing to rebuild this document from.",
      });
      continue; // every later check needs a log
    }

    // --- 2. invariant-1 ---------------------------------------------------
    const firstRow = new Uint8Array(updates[0].update);
    let replayed: Decoded;
    let replayDoc: Y.Doc | null = null;
    try {
      if (!isSelfSufficient(firstRow)) {
        findings.push({
          level: "error",
          ydocId: row.id,
          check: "invariant-1",
          detail:
            `row #1 (id ${updates[0].id}) is not a full state — applying it to an empty document ` +
            "leaves pending structs, so any replay from the start begins from an incomplete document.",
        });
      }

      // --- 3. blob-vs-log -------------------------------------------------
      replayDoc = new Y.Doc();
      for (const u of updates) Y.applyUpdate(replayDoc, new Uint8Array(u.update));
      replayed = decodeDoc(replayDoc);
    } catch (err) {
      findings.push({
        level: "error",
        ydocId: row.id,
        check: "replay",
        detail: `replaying the log threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      replayDoc?.destroy();
      continue;
    }

    let stored: Decoded;
    try {
      stored = decode(blob);
    } catch (err) {
      findings.push({
        level: "error",
        ydocId: row.id,
        check: "blob-decode",
        detail: `ydoc.ydoc is not a valid Yjs update: ${err instanceof Error ? err.message : String(err)}`,
      });
      replayDoc.destroy();
      continue;
    }

    if (stored.sv !== replayed.sv) {
      findings.push({
        level: "error",
        ydocId: row.id,
        check: "blob-vs-log",
        detail: `state vectors differ — the blob and a replay of ${updates.length} update(s) know different items.`,
      });
    }
    if (stored.body !== replayed.body) {
      findings.push({
        level: "error",
        ydocId: row.id,
        check: "blob-vs-log",
        detail:
          `body differs — blob ${stored.body.length} chars vs replayed ${replayed.body.length} chars.\n` +
          `        blob:     ${truncate(stored.body)}\n` +
          `        replayed: ${truncate(replayed.body)}`,
      });
    }
    if (stored.title !== replayed.title) {
      findings.push({
        level: "error",
        ydocId: row.id,
        check: "blob-vs-log",
        detail:
          `title differs — blob ${JSON.stringify(truncate(stored.title))} ` +
          `vs replayed ${JSON.stringify(truncate(replayed.title))}.`,
      });
    }

    // --- 4. snapshots -----------------------------------------------------
    const snapshots = await prisma.ydocSnapshot.findMany({
      where: { ydocId: row.id },
      orderBy: { lastYdocUpdateId: "asc" },
      select: { id: true, ydoc: true, lastYdocUpdateId: true },
    });

    for (const snap of snapshots) {
      const upTo = new Y.Doc();
      try {
        for (const u of updates) {
          if (u.id > snap.lastYdocUpdateId) break;
          Y.applyUpdate(upTo, new Uint8Array(u.update));
        }
        const expected = decodeDoc(upTo);
        const actual = decode(new Uint8Array(snap.ydoc));
        if (expected.sv !== actual.sv || expected.body !== actual.body || expected.title !== actual.title) {
          findings.push({
            level: "error",
            ydocId: row.id,
            check: "snapshot",
            detail:
              `snapshot ${snap.id} (through update ${snap.lastYdocUpdateId}) does not match a replay to that ` +
              "mark — the replay slider rebuilds from it, so every position at or after the mark is wrong.",
          });
        }
      } catch (err) {
        findings.push({
          level: "error",
          ydocId: row.id,
          check: "snapshot",
          detail: `snapshot ${snap.id} could not be compared: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        upTo.destroy();
      }
    }

    // --- 5. title-cache (docs only) ---------------------------------------
    const ownerDocId = docIdFromYdocId(row.id);
    if (ownerDocId) {
      const doc = await prisma.doc.findUnique({ where: { id: ownerDocId }, select: { title: true, slug: true } });
      if (doc) {
        const fragmentTitle = titleTextOf(replayDoc);
        if (fragmentTitle === null && doc.title !== "") {
          findings.push({
            level: "warn",
            ydocId: row.id,
            check: "title-cache",
            detail:
              `ydoc has no title fragment but Doc.title is ${JSON.stringify(doc.title)} (/doc/${doc.slug}) — ` +
              "server/doc-cache.ts will overwrite it with an empty string on the next store debounce.",
          });
        } else if (fragmentTitle !== null && fragmentTitle !== doc.title && verbose) {
          findings.push({
            level: "warn",
            ydocId: row.id,
            check: "title-cache",
            detail:
              `Doc.title ${JSON.stringify(doc.title)} is stale against the ydoc's ` +
              `${JSON.stringify(fragmentTitle)} — the cache self-corrects on the next store.`,
          });
        }
      }
    }

    replayDoc.destroy();

    if (findings.length === before) {
      passed += 1;
      if (verbose) console.log(`  OK    ${row.id}  (${updates.length} update(s), ${snapshots.length} snapshot(s))`);
    }
  }

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");

  for (const f of findings) {
    console.log(`  ${f.level === "error" ? "FAIL" : "WARN"}  ${f.ydocId}`);
    console.log(`        [${f.check}] ${f.detail}`);
  }

  console.log(
    `\n${ydocs.length} checked — ${passed} clean, ${errors.length} error(s), ${warnings.length} warning(s).`,
  );
  if (errors.length > 0) {
    console.log(
      "\nA blob-vs-log mismatch is repaired by rewriting the blob from the log " +
        "(the log is the rebuildable side; see scripts/import-legacy.ts's header for the reasoning).\n",
    );
  } else {
    console.log("");
  }

  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
