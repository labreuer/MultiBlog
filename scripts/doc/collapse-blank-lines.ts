// Collapse every "2x" newline run in a doc down to "1x" — i.e. delete the
// single empty paragraph that sits between two non-empty blocks, leaving an
// ordinary paragraph break. Runs of 3 or more are left exactly as they are:
// this is "2x -> 1x", not "squash all blank runs". Companion to
// scripts/doc/count-newline-runs.ts, which reports the runs this acts on; both
// read the same model from scripts/doc/lib/newline-runs.ts so they cannot drift.
//
// Usage:
//   npx tsx scripts/doc/collapse-blank-lines.ts [--file <path>] [--dry-run]
//                                           [--include-deleted] [--force]
//
// --file <path>      newline-delimited list of docs to touch, each line a doc
//                    id, an exact title (case-insensitive), or a slug. Blank
//                    lines and lines starting with # are ignored. A line that
//                    matches nothing — or matches more than one doc — aborts
//                    the whole run before anything is written. Omit the flag
//                    to process every doc.
// --dry-run          do all the work and report it, write nothing.
// --include-deleted  also process soft-deleted docs (skipped by default).
// --force            proceed even though something is listening on the collab
//                    port. See "the collab server must be stopped" below.
//
// ---------------------------------------------------------------------------
// THE EDIT IS MADE IN THE YDOC, NOT IN prose_json
//
// A doc's ydoc row IS the doc; title/prose_json are only caches of it (PLAN.md
// §3d/§12d, and CLAUDE.md's "A doc's `ydoc` row *is* the doc"). Rewriting
// prose_json alone would be a lie the next store debounce silently reverts, and
// would leave every annotation's anchor mark pointing into content the ydoc
// still has. So this script does what an editor does: loads the ydoc, deletes
// the empty paragraph nodes from the "default" XmlFragment inside one
// Y.Doc.transact, and persists the result the way server/ydoc-hooks.ts would —
//   1. the emitted Yjs update appended to ydoc_update (the log is never
//      truncated, §11b, so this shows up as a normal edit in /ydoc-debug and
//      the doc's scrub bar),
//   2. the full state + state vector written back to ydoc,
//   3. prose_json recomputed from the mutated Y.Doc with the very same
//      docContentFromYdoc() that server/doc-cache.ts uses.
// prose_json_length needs no handling at all: the doc_sync_prose_json_length
// trigger owns that column and fires on any UPDATE naming prose_json (never
// assign to it — CLAUDE.md).
//
// All three land in one Prisma transaction, so a doc is never left with a log
// entry its ydoc blob doesn't reflect. scripts/integrity/ is the acceptance
// test afterwards, ydoc check first.
//
// Doc.title is deliberately NOT rewritten. This edit never touches the title
// fragment, so re-deriving the title cache here could only overwrite a
// pre-existing title/fragment disagreement with a different one. Any such
// disagreement is reported instead, for check-doc-integrity.ts to adjudicate.
//
// Doc.updated_at IS PRESERVED; ydoc.updated_at AND ydoc_update.created_at ARE NOT
// Of the three timestamps this touches, only doc.updated_at is a claim about the
// *document* — it is the date under the byline on /doc/<slug> and the "Updated"
// column on /docs. Tidying whitespace is not editorial activity, so that one is
// read before the write and put back after it.
//
// The other two are storage bookkeeping and are left truthful. ydoc_update gets
// a genuinely new row, and backdating its created_at would put a lie in an
// append-only log the scrub bar renders (replay itself orders by id, so the
// damage would be a visibly non-monotonic timeline rather than a broken one).
// ydoc.updated_at is only read by /ydoc-debug's ten-most-recent listing, which
// is ADMIN-only and whose whole job is to say what changed last — pinning it
// back would be both a lie and less useful. Nothing compares the three (neither
// integrity checker looks at updated_at at all) and nothing caches on them, so
// the divergence costs nothing. Note the y-indexeddb lineage key is
// ydoc.created_at, not updated_at (PLAN.md §11e), and is untouched either way.
//
// ---------------------------------------------------------------------------
// "AS THE FIRST LISTED AUTHOR"
//
// Per-edit attribution in this stack is the ydoc's own `clients` map —
// clientID -> user id, written by server/ydoc-hooks.ts's attributeUpdate
// (PLAN.md §11d) and read back by src/lib/ydoc-render.ts. ydoc_update itself
// has no user column, so that map is the whole mechanism. This script
// therefore takes the doc's first-listed author (doc_author ordered by
// byline_order, then user id to break a tie), gives the Y.Doc a deterministic
// clientID derived from that user, and registers the pair in `clients` inside
// the same transaction as the deletions — exactly what import-etherpad.ts does
// per Etherpad author. The clientID is bumped on collision with any id already
// present in the document, so the edit can never be silently folded into
// someone else's client. No authorHighlight marks are involved: this only
// deletes, and that mark only ever tags inserted text.
//
// ---------------------------------------------------------------------------
// THE COLLAB SERVER MUST BE STOPPED
//
// If Hocuspocus has the doc loaded in memory, its next store debounce writes
// its own (unmodified) state straight over ours and the edit vanishes. So the
// script refuses to run while anything is listening on COLLAB_PORT. `--force`
// overrides that, and is only correct if you know the port belongs to
// something else.
//
// ---------------------------------------------------------------------------
// WHAT IS SKIPPED, AND WHY
//
// - A blank line produced by a hardBreak rather than by an empty paragraph:
//   there is no whole block to delete, so it is reported and left alone.
// - An empty paragraph that is its container's only child (the sole paragraph
//   of a blockquote or list item): removing it would leave an empty container,
//   which the ProseMirror schema rejects. Reported and left alone.
// - A leading or trailing blank line: neither produces a 2x run in the first
//   place (see interiorBlankGroups), so neither is in scope.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import * as Y from "yjs";
import { docContentFromYdoc } from "../../src/lib/doc-content";
import { ydocIdForDoc } from "../../src/lib/ydoc-names";
import { encodeYdocState } from "../../server/ydoc-store";
import { prisma } from "../../src/lib/prisma";
import type { Prisma } from "../../src/generated/prisma/client";
import {
  CONTAINERS,
  flattenLines,
  interiorBlankGroups,
  linesToText,
  newlineRuns,
  renderText,
  runHistogram,
} from "./lib/newline-runs";

// ---------------------------------------------------------------------------
// Yjs side of the shared block model
// ---------------------------------------------------------------------------

type YBlock = {
  parent: Y.XmlFragment;
  index: number;
  nodeName: string;
  childCount: number;
};

// Depth-first over the fragment's leaf blocks, in exactly the order
// flattenLines() assigns its blockIndex — the two walks must agree on what a
// container is, which is why CONTAINERS is imported rather than restated.
function leafBlocks(parent: Y.XmlFragment, out: YBlock[]): void {
  parent.toArray().forEach((child, index) => {
    if (child instanceof Y.XmlElement && CONTAINERS.has(child.nodeName)) {
      leafBlocks(child, out);
      return;
    }
    out.push({
      parent,
      index,
      nodeName: child instanceof Y.XmlElement ? child.nodeName : "#text",
      childCount: child instanceof Y.XmlElement ? child.length : 0,
    });
  });
}

// Deterministic, nonzero — same FNV-1a as import-etherpad's clientIdFor, so a
// re-run reuses the same client rather than accumulating one per invocation.
function clientIdFor(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function usedClientIds(doc: Y.Doc): Set<number> {
  const used = new Set<number>(Y.decodeStateVector(Y.encodeStateVector(doc)).keys());
  doc.getMap<string>("clients").forEach((_userId, clientId) => {
    const parsed = Number(clientId);
    if (Number.isFinite(parsed)) used.add(parsed);
  });
  return used;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function collabPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readTargetFile(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// ---------------------------------------------------------------------------

type DocRow = {
  id: string;
  slug: string;
  title: string;
  deletedAt: Date | null;
  authors: { userId: string; bylineOrder: number }[];
};

type Skip = { reason: string; detail: string };

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const includeDeleted = argv.includes("--include-deleted");
  const force = argv.includes("--force");
  const fileArgIndex = argv.indexOf("--file");
  const filePath =
    fileArgIndex >= 0
      ? argv[fileArgIndex + 1]
      : argv.find((a) => a.startsWith("--file="))?.slice("--file=".length);

  if (fileArgIndex >= 0 && !filePath) {
    console.error("--file needs a path.");
    process.exit(1);
  }

  // Only the writing path can be clobbered by a live Hocuspocus, so --dry-run
  // is exempt — otherwise checking what a run would do would mean stopping the
  // dev server first, which is the opposite of what a dry run is for.
  const collabPort = Number(process.env.COLLAB_PORT ?? 1234);
  if (!dryRun && (await collabPortInUse(collabPort))) {
    if (!force) {
      console.error(
        `Something is listening on the collab port (${collabPort}). If that is the\n` +
          `Hocuspocus server, it holds these docs in memory and its next store debounce\n` +
          `would overwrite this edit. Stop it (npm run stop:all) and re-run, or pass\n` +
          `--force if you know the port belongs to something else.`,
      );
      process.exit(1);
    }
    console.warn(`WARNING: collab port ${collabPort} is in use and --force was given.\n`);
  }

  const all = await prisma.doc.findMany({
    where: includeDeleted ? {} : { deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      deletedAt: true,
      authors: { select: { userId: true, bylineOrder: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Resolve the target list before touching anything: an unresolvable line is
  // a mistake in the input, and half-applying the rest of the file would be
  // the worst possible response to it.
  let targets: DocRow[];
  if (filePath) {
    const wanted = readTargetFile(filePath);
    const problems: string[] = [];
    const picked = new Map<string, DocRow>();
    for (const line of wanted) {
      const key = line.toLowerCase();
      const matches = all.filter(
        (d) => d.id === line || d.slug.toLowerCase() === key || d.title.toLowerCase() === key,
      );
      if (matches.length === 0) problems.push(`no doc matches ${JSON.stringify(line)}`);
      else if (matches.length > 1)
        problems.push(
          `${JSON.stringify(line)} matches ${matches.length} docs: ${matches.map((m) => m.id).join(", ")}`,
        );
      else picked.set(matches[0].id, matches[0]);
    }
    if (problems.length) {
      console.error(`Could not resolve ${problems.length} line(s) of ${filePath}; nothing was written:`);
      for (const p of problems) console.error(`  ${p}`);
      console.error(
        includeDeleted ? "" : "  (soft-deleted docs are excluded — add --include-deleted if that's the cause)",
      );
      process.exit(1);
    }
    targets = [...picked.values()];
  } else {
    targets = all;
  }

  console.log(
    `${dryRun ? "DRY RUN — " : ""}collapsing 2x newline runs to 1x in ${targets.length} doc(s)` +
      `${filePath ? ` from ${filePath}` : " (every doc)"}.\n`,
  );

  let changedDocs = 0;
  let deletedParagraphs = 0;
  const skipped: { doc: DocRow; skips: Skip[] }[] = [];
  const titleDrift: string[] = [];

  for (const target of targets) {
    const ydocId = ydocIdForDoc(target.id);
    const row = await prisma.ydoc.findUnique({ where: { id: ydocId } });
    if (!row) {
      console.log(`SKIP  ${target.title} (${target.id}) — no ydoc row`);
      continue;
    }

    const author = [...target.authors].sort(
      (a, b) => a.bylineOrder - b.bylineOrder || a.userId.localeCompare(b.userId),
    )[0];
    if (!author) {
      console.log(`SKIP  ${target.title} (${target.id}) — no authors, so no identity to edit as`);
      continue;
    }

    const state = new Y.Doc();
    Y.applyUpdate(state, new Uint8Array(row.ydoc));

    let before: { proseJson: unknown; title: string };
    try {
      before = docContentFromYdoc(state);
    } catch (err) {
      console.log(`SKIP  ${target.title} (${target.id}) — ydoc isn't TipTap-compatible: ${err}`);
      state.destroy();
      continue;
    }

    const lines = flattenLines(before.proseJson);
    const blocks: YBlock[] = [];
    leafBlocks(state.getXmlFragment("default"), blocks);

    const jsonBlockCount = lines.length ? Math.max(...lines.map((l) => l.blockIndex)) + 1 : 0;
    if (jsonBlockCount !== blocks.length) {
      // The JSON walk and the Yjs walk disagree about the block structure, so
      // a blockIndex would address the wrong node. Never guess — bail on this
      // doc and say so.
      console.log(
        `SKIP  ${target.title} (${target.id}) — block-structure mismatch ` +
          `(${jsonBlockCount} in prose JSON vs ${blocks.length} in the ydoc)`,
      );
      state.destroy();
      continue;
    }

    // Only groups of exactly one blank line are in scope: that is a 2x run.
    const skips: Skip[] = [];
    const toDelete: YBlock[] = [];
    for (const group of interiorBlankGroups(lines)) {
      if (group.runLength !== 2) continue;
      const line = lines[group.lineIndices[0]];
      if (!line.whole) {
        skips.push({
          reason: "hardBreak",
          detail: `blank line at block ${line.blockIndex} comes from a hardBreak, not an empty paragraph`,
        });
        continue;
      }
      const block = blocks[line.blockIndex];
      if (block.nodeName !== "paragraph") {
        skips.push({
          reason: "not-a-paragraph",
          detail: `blank block ${line.blockIndex} is a <${block.nodeName}>, left alone`,
        });
        continue;
      }
      toDelete.push(block);
    }

    // Deleting a container's last child would leave it empty, which the schema
    // rejects. Count per parent first, then drop any parent that would be
    // emptied — the root fragment excepted, which may legitimately go empty.
    const root = state.getXmlFragment("default");
    const perParent = new Map<Y.XmlFragment, YBlock[]>();
    for (const block of toDelete) {
      const list = perParent.get(block.parent) ?? [];
      list.push(block);
      perParent.set(block.parent, list);
    }
    const deletionsByParent = new Map<Y.XmlFragment, YBlock[]>();
    let deletionCount = 0;
    for (const [parent, list] of perParent) {
      if (parent !== root && list.length === parent.length) {
        skips.push({
          reason: "would-empty-container",
          detail: `${list.length} empty paragraph(s) are all of a container's children, left alone`,
        });
        continue;
      }
      deletionsByParent.set(parent, list);
      deletionCount += list.length;
    }

    if (skips.length) skipped.push({ doc: target, skips });

    if (deletionCount === 0) {
      state.destroy();
      continue;
    }

    // Attribute the edit before making it: a clientID this document has never
    // used, mapped to the first-listed author in the same transaction.
    const used = usedClientIds(state);
    let clientId = clientIdFor(`collapse-blank-lines:${author.userId}`);
    while (used.has(clientId)) clientId = (clientId + 1) >>> 0 || 1;
    state.clientID = clientId;

    const emitted: Uint8Array[] = [];
    state.on("update", (update: Uint8Array) => emitted.push(new Uint8Array(update)));

    state.transact(() => {
      const clients = state.getMap<string>("clients");
      if (!clients.has(String(clientId))) clients.set(String(clientId), author.userId);
      // Highest index first within each parent, so earlier deletions can't
      // shift the position of the ones still to come.
      for (const [parent, list] of deletionsByParent) {
        for (const block of [...list].sort((a, b) => b.index - a.index)) {
          parent.delete(block.index, 1);
        }
      }
    });

    if (emitted.length === 0) {
      console.log(`SKIP  ${target.title} (${target.id}) — transaction emitted no update`);
      state.destroy();
      continue;
    }

    let after: { proseJson: unknown; title: string };
    try {
      after = docContentFromYdoc(state);
    } catch (err) {
      console.log(`SKIP  ${target.title} (${target.id}) — edit produced a non-TipTap doc, discarded: ${err}`);
      state.destroy();
      continue;
    }

    if (after.title !== target.title) {
      titleDrift.push(
        `${target.id}: Doc.title ${JSON.stringify(target.title)} vs title fragment ${JSON.stringify(after.title)}`,
      );
    }

    const beforeRuns = runHistogram(newlineRuns(linesToText(lines)));
    const afterRuns = runHistogram(newlineRuns(renderText(after.proseJson)));
    const fmt = (h: Map<number, number>) =>
      [...h.keys()]
        .sort((a, b) => a - b)
        .map((k) => `${k}x:${h.get(k)}`)
        .join(" ") || "none";

    console.log(
      `${dryRun ? "WOULD" : "EDIT "} ${target.title} (${target.id})\n` +
        `      -${deletionCount} empty paragraph(s) as ${author.userId} (clientID ${clientId})\n` +
        `      runs ${fmt(beforeRuns)}  ->  ${fmt(afterRuns)}`,
    );
    if (afterRuns.has(2)) {
      console.log(`      NOTE: ${afterRuns.get(2)} run(s) of 2 remain — see the skip report below`);
    }

    changedDocs += 1;
    deletedParagraphs += deletionCount;

    if (!dryRun) {
      const update = emitted.length === 1 ? emitted[0] : Y.mergeUpdates(emitted);
      const { ydoc, stateVector } = encodeYdocState(state);
      await prisma.$transaction(async (tx) => {
        await tx.ydocUpdate.create({ data: { ydocId, update: Buffer.from(update) } });
        await tx.ydoc.update({
          where: { id: ydocId },
          data: { ydoc: Buffer.from(ydoc), stateVector: Buffer.from(stateVector) },
        });

        // Read inside the transaction, not from the `targets` query above: the
        // web server may still be running (only the collab port is checked),
        // and a doc's updated_at can move under a title edit in between.
        const before = await tx.doc.findUnique({
          where: { id: target.id },
          select: { updatedAt: true },
        });

        // prose_json only — Doc.title is left to the title fragment's own
        // cache path, see the header. prose_json_length is the trigger's.
        await tx.doc.update({
          where: { id: target.id },
          data: { proseJson: after.proseJson as Prisma.InputJsonValue },
        });

        // Put updated_at back where it was. Doc.updatedAt is @updatedAt, which
        // Prisma applies client-side, so the update above stamps it with now()
        // whether or not the column is named — the same reason
        // import-etherpad.ts backdates it by hand. Raw SQL because there is no
        // way to tell Prisma Client not to. Naming only updated_at also keeps
        // the doc_sync_prose_json_length trigger out of it: it is declared
        // BEFORE INSERT OR UPDATE **OF prose_json**, so this statement does not
        // re-fire it.
        if (before) {
          await tx.$executeRaw`UPDATE "doc" SET "updated_at" = ${before.updatedAt} WHERE "id" = ${target.id}`;
        }
      });
    }

    state.destroy();
  }

  console.log(
    `\n${dryRun ? "Would have changed" : "Changed"} ${changedDocs} doc(s), ` +
      `${dryRun ? "removing" : "removed"} ${deletedParagraphs} empty paragraph(s).`,
  );

  if (skipped.length) {
    console.log(`\nLeft alone in ${skipped.length} doc(s):`);
    for (const { doc, skips } of skipped) {
      console.log(`  ${doc.title} (${doc.id})`);
      for (const s of skips) console.log(`    [${s.reason}] ${s.detail}`);
    }
  }

  if (titleDrift.length) {
    console.log(
      `\nDoc.title disagrees with the title fragment in ${titleDrift.length} doc(s) ` +
        `(pre-existing, not written by this script — scripts/integrity/check-doc-integrity.ts):`,
    );
    for (const d of titleDrift) console.log(`  ${d}`);
  }

  if (!dryRun && changedDocs > 0) {
    console.log(
      `\nRun scripts/integrity/ next (ydoc check first) to confirm the ` +
        `ydoc_update -> ydoc.ydoc -> doc.prose_json chain still agrees.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
