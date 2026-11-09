// Verifies the chip kinds' index tables, `mention` and `citation`
// (docs/ENTITY_CHIPS.md, step 1, item 12): that each one's rows are exactly
// the chips of its kind the documents hold. The tables share a shape, so one
// script checks both; it keeps the name it had when there was one.
//
// Why this needs a check at all: each table is written by triggers
// (migrations `mention_index`, `citation_index`) and read by things that
// would not notice it being wrong. The label refresh after a rename, or a
// corrected reference, finds the docs to rewrite through it, so a missing row
// is a doc that goes on showing, and being found by, the old label; an extra
// row is a mention or citation reported where there is none.
//
// Three checks:
//
//   - `trigger`: each of the four triggers exists and is enabled. The other
//     checks cannot tell a disabled trigger from bad luck, and `--repair`
//     works by calling what they call.
//   - `missing`: a mention chip in a document with no row. The expected rows
//     come from the very functions the triggers call (`mentions_wanted`,
//     `post_mentions_wanted`), so the two cannot disagree about what a
//     document mentions. A chip naming no account is expected to have no row.
//   - `extra`: a row whose chip its document no longer holds, or a row for a
//     DRAFT annotation or a comment that isn't APPROVED, which have none.
//
// `--repair` calls `mention_sync` for every drifted source, which is a diff:
// rows whose chips are still there keep their `first_seen_at`. A row it adds
// is first seen at the repair.
//
// Reads only without `--repair`. Safe to run at any time, because a row is
// written in the same statement as the document it is of: there is no lag to
// excuse.
//
// Usage:
//   npx tsx scripts/integrity/check-mentions.ts
//   ... --verbose        list every drifted row
//   ... --repair         fix what it finds, then check again
//
// Exits non-zero on any finding.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const repair = args.includes("--repair");

// Every name below is a constant of this file and none is user input, which
// is what makes the $queryRawUnsafe calls that interpolate them safe.
type Source = {
  table: string;
  column: "doc_id" | "post_id" | "annotation_id" | "comment_id";
  trigger: string;
  /** SQL over the source aliased `s`: the jsonb array of {iid, <target>} its rows should be. */
  wanted: string;
  /** The sync function's four id arguments for a source row aliased `s`. */
  syncArgs: string;
};

/** One chip kind's index table: what it points at, and the SQL that keeps it. */
type Index = {
  table: "mention" | "citation";
  /** The column naming the target, and the table the target lives in. */
  target: string;
  targetTable: string;
  sync: string;
  sources: Source[];
};

function sourcesOf(noun: string, wanted: string, postWanted: string): Source[] {
  return [
    { table: "doc", column: "doc_id", trigger: `doc_sync_${noun}`, wanted: `public.${wanted}(s.prose_json)`, syncArgs: "s.id, NULL, NULL, NULL" },
    {
      table: "annotation",
      column: "annotation_id",
      trigger: `annotation_sync_${noun}`,
      wanted: `CASE WHEN s.status = 'DRAFT' THEN '[]'::jsonb ELSE public.${wanted}(s.prose_json) END`,
      syncArgs: "NULL, NULL, s.id, NULL",
    },
    { table: "post", column: "post_id", trigger: `post_sync_${noun}`, wanted: `public.${postWanted}(s.prose_json)`, syncArgs: "NULL, s.id, NULL, NULL" },
    // Only an APPROVED comment has rows (migration `comment_chip_index`).
    {
      table: "comment",
      column: "comment_id",
      trigger: `comment_sync_${noun}`,
      wanted: `CASE WHEN s.status = 'APPROVED' THEN public.${wanted}(s.body) ELSE '[]'::jsonb END`,
      syncArgs: "NULL, NULL, NULL, s.id",
    },
  ];
}

const INDEXES: Index[] = [
  { table: "mention", target: "user_id", targetTable: "user", sync: "mention_sync", sources: sourcesOf("mentions", "mentions_wanted", "post_mentions_wanted") },
  {
    table: "citation",
    target: "reference_id",
    targetTable: "reference",
    sync: "citation_sync",
    sources: sourcesOf("citations", "citations_wanted", "post_citations_wanted"),
  },
];

type Drift = { index: Index["table"]; source: string; id: string; iid: string; targetId: string };
type Report = { triggers: string[]; missing: Drift[]; extra: Drift[] };

async function check(): Promise<Report> {
  const report: Report = { triggers: [], missing: [], extra: [] };
  for (const index of INDEXES) await checkIndex(index, report);
  return report;
}

async function checkIndex(index: Index, report: Report): Promise<void> {
  for (const source of index.sources) {
    const [trigger] = await prisma.$queryRawUnsafe<{ enabled: string }[]>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass AND NOT tgisinternal`,
      source.trigger,
      `"${source.table}"`,
    );
    if (!trigger) report.triggers.push(`${source.trigger} on ${source.table} does not exist`);
    else if (trigger.enabled === "D") report.triggers.push(`${source.trigger} on ${source.table} is disabled`);

    // What each source should have, joined to the targets that exist: a chip
    // naming none has no row by design.
    const wanted = `
      SELECT s.id AS source_id, w.iid, w.${index.target} AS target_id
      FROM "${source.table}" s
      CROSS JOIN LATERAL jsonb_to_recordset(${source.wanted}) AS w(iid text, ${index.target} text)
      JOIN "${index.targetTable}" t ON t.id = w.${index.target}
    `;
    const missing = await prisma.$queryRawUnsafe<{ source_id: string; iid: string; target_id: string }[]>(`
      SELECT w.source_id, w.iid, w.target_id FROM (${wanted}) w
      WHERE NOT EXISTS (
        SELECT 1 FROM "${index.table}" m WHERE m.${source.column} = w.source_id AND m.iid = w.iid AND m.${index.target} = w.target_id
      )
    `);
    const extra = await prisma.$queryRawUnsafe<{ source_id: string; iid: string; target_id: string }[]>(`
      SELECT m.${source.column} AS source_id, m.iid, m.${index.target} AS target_id FROM "${index.table}" m
      WHERE m.${source.column} IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM (${wanted}) w WHERE w.source_id = m.${source.column} AND w.iid = m.iid AND w.target_id = m.${index.target}
      )
    `);
    const drift = (row: { source_id: string; iid: string; target_id: string }): Drift => ({
      index: index.table,
      source: source.table,
      id: row.source_id,
      iid: row.iid,
      targetId: row.target_id,
    });
    report.missing.push(...missing.map(drift));
    report.extra.push(...extra.map(drift));
  }
}

function print(report: Report): number {
  const count = report.triggers.length + report.missing.length + report.extra.length;
  for (const line of report.triggers) console.log(`  ERROR [trigger] ${line}`);
  for (const [name, rows] of [
    ["missing", report.missing],
    ["extra", report.extra],
  ] as const) {
    if (rows.length === 0) continue;
    const sources = new Set(rows.map((row) => `${row.index}:${row.source}:${row.id}`));
    console.log(`  ERROR [${name}] ${rows.length} row(s) across ${sources.size} source(s)`);
    if (verbose) for (const row of rows) console.log(`          ${row.index}  ${row.source} ${row.id}  chip ${row.iid}  target ${row.targetId}`);
  }
  return count;
}

async function repairIndex(report: Report) {
  for (const index of INDEXES) {
    for (const source of index.sources) {
      const ids = [
        ...new Set(
          [...report.missing, ...report.extra].filter((row) => row.index === index.table && row.source === source.table).map((row) => row.id),
        ),
      ];
      if (ids.length === 0) continue;
      await prisma.$queryRawUnsafe(
        // Cast to text: the function returns void, which the driver can't read back.
        `SELECT public.${index.sync}(${source.syncArgs}, ${source.wanted})::text FROM "${source.table}" s WHERE s.id = ANY($1::text[])`,
        ids,
      );
      console.log(`  repaired ${index.table}: ${ids.length} ${source.table}(s)`);
    }
  }
}

async function main() {
  console.log("");
  for (const index of INDEXES) {
    const [{ rows }] = await prisma.$queryRawUnsafe<{ rows: bigint }[]>(`SELECT count(*) AS rows FROM "${index.table}"`);
    console.log(`${index.table} index: ${rows} row(s)`);
  }

  let report = await check();
  let errors = print(report);

  if (repair && errors > 0) {
    if (report.triggers.length > 0) {
      console.log("\nNot repairing: with a trigger missing or disabled the rows would drift again at the next write. Restore it first.");
    } else {
      console.log("\nrepairing…");
      await repairIndex(report);
      report = await check();
      errors = print(report);
    }
  }

  console.log(errors === 0 ? "\nno errors\n" : `\n${errors} error(s)${verbose ? "" : " — --verbose lists them"}\n`);
  await prisma.$disconnect();
  process.exit(errors === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
