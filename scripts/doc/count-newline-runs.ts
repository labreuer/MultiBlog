// Report, per doc, how many runs of consecutive newlines its body contains —
// how many single newlines (an ordinary paragraph break), how many doubles
// (one blank line between paragraphs), how many triples, and so on. Written
// for auditing imported content, where stray blank lines from the source
// format show up as runs of 3+.
//
// Usage:
//   npx tsx scripts/doc/count-newline-runs.ts [--include-deleted] [--min-run=N] [--csv]
//
// --include-deleted  also report soft-deleted docs (excluded by default)
// --min-run=N        only report docs having at least one run of N or more
//                    newlines; the printed counts are still the full picture
//                    for those docs. Default 1 (every doc).
// --csv              emit `docId,title,runLength,count` rows instead of the
//                    human-readable listing.
//
// Read-only: opens nothing but SELECTs.
//
// What counts as a newline is defined once in scripts/doc/lib/newline-runs.ts and
// shared with scripts/doc/collapse-blank-lines.ts, which acts on this report's
// answer — read that file's header for the model. In short: a doc's body is
// TipTap JSON with no literal "\n" in it, so the runs counted here are the
// newlines of its plain-text rendering, where an empty paragraph between two
// filled ones is a run of 2.
//
// Doc.proseJson is a cache of the doc's ydoc (PLAN.md §12d) written by
// server/doc-cache.ts on the collab server's store debounce, so a doc being
// edited right now can be a few seconds stale, and a doc created but never
// edited has proseJson NULL — those are listed separately as "no body" rather
// than silently counted as empty.

import "dotenv/config";
import { prisma } from "../../src/lib/prisma";
import { newlineRuns, renderText, runHistogram } from "./lib/newline-runs";

async function main() {
  const argv = process.argv.slice(2);
  const includeDeleted = argv.includes("--include-deleted");
  const csv = argv.includes("--csv");
  const minRunArg = argv.find((a) => a.startsWith("--min-run="));
  const minRun = minRunArg ? Number(minRunArg.slice("--min-run=".length)) : 1;

  if (!Number.isInteger(minRun) || minRun < 1) {
    console.error(`--min-run must be a positive integer, got ${minRunArg}`);
    process.exit(1);
  }

  const docs = await prisma.doc.findMany({
    where: includeDeleted ? {} : { deletedAt: null },
    select: { id: true, title: true, proseJson: true, deletedAt: true },
    orderBy: { createdAt: "asc" },
  });

  const noBody: { id: string; title: string }[] = [];
  const rows: {
    id: string;
    title: string;
    deleted: boolean;
    counts: Map<number, number>;
    maxRun: number;
    total: number;
  }[] = [];

  for (const doc of docs) {
    if (doc.proseJson === null || doc.proseJson === undefined) {
      noBody.push({ id: doc.id, title: doc.title });
      continue;
    }
    const runs = newlineRuns(renderText(doc.proseJson));
    const counts = runHistogram(runs);
    rows.push({
      id: doc.id,
      title: doc.title,
      deleted: doc.deletedAt !== null,
      counts,
      maxRun: runs.length ? Math.max(...runs) : 0,
      total: runs.length,
    });
  }

  // Worst offenders first: longest run, then how many of that length, then
  // how many runs overall.
  const reported = rows
    .filter((r) => r.maxRun >= minRun)
    .sort(
      (a, b) =>
        b.maxRun - a.maxRun ||
        (b.counts.get(b.maxRun) ?? 0) - (a.counts.get(a.maxRun) ?? 0) ||
        b.total - a.total,
    );

  if (csv) {
    console.log("docId,title,runLength,count");
    for (const r of reported) {
      for (const len of [...r.counts.keys()].sort((a, b) => a - b)) {
        const title = `"${r.title.replace(/"/g, '""')}"`;
        console.log(`${r.id},${title},${len},${r.counts.get(len)}`);
      }
    }
  } else {
    // One column per run length that actually occurs, so a corpus with no
    // 7-newline runs doesn't carry an empty "7x" column across every row.
    const lengths = [
      ...new Set(reported.flatMap((r) => [...r.counts.keys()])),
    ].sort((a, b) => a - b);

    const titleOf = (r: (typeof reported)[number]) =>
      r.title + (r.deleted ? " [deleted]" : "");
    const totals = new Map(
      lengths.map((len) => [
        len,
        reported.reduce((sum, r) => sum + (r.counts.get(len) ?? 0), 0),
      ]),
    );

    const headers = ["Title", "Doc ID", ...lengths.map((len) => `${len}x`)];
    const body = reported.map((r) => [
      titleOf(r),
      r.id,
      ...lengths.map((len) => String(r.counts.get(len) ?? "")),
    ]);
    const footer = [
      `${reported.length} doc(s)`,
      "",
      ...lengths.map((len) => String(totals.get(len))),
    ];

    const widths = headers.map((h, i) =>
      Math.max(h.length, ...[...body, footer].map((row) => row[i].length)),
    );
    // Title and Doc ID read left-to-right; the counts line up on the right.
    const pad = (cell: string, i: number) =>
      i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]);
    const line = (row: string[]) => row.map(pad).join("  ").trimEnd();

    console.log(line(headers));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of body) console.log(line(row));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    console.log(line(footer));

    console.log(
      `\n${reported.length} of ${rows.length} doc(s) with a body reported` +
        (minRun > 1 ? ` (--min-run=${minRun})` : "") +
        `. "1x" is an ordinary paragraph break, "2x" one blank line between` +
        ` paragraphs, "3x" two, and so on; a blank cell is none of that length.`,
    );
    if (noBody.length) {
      console.log(`\n${noBody.length} doc(s) with no body (prose_json NULL):`);
      for (const d of noBody) console.log(`  ${d.title} — ${d.id}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
