// Verifies the `mention` index (docs/ENTITY_CHIPS.md, step 1, item 12): that
// its rows are exactly the mention chips the documents hold.
//
// Why this needs a check at all: the table is written by triggers (migration
// `mention_index`) and read by things that would not notice it being wrong.
// The label refresh after a rename finds the docs to rewrite through it, so a
// missing row is a doc that goes on showing, and being found by, the old
// name; an extra row is a mention reported where there is none.
//
// Three checks:
//
//   - `trigger`: each of the three triggers exists and is enabled. The other
//     checks cannot tell a disabled trigger from bad luck, and `--repair`
//     works by calling what they call.
//   - `missing`: a mention chip in a document with no row. The expected rows
//     come from the very functions the triggers call (`mentions_wanted`,
//     `post_mentions_wanted`), so the two cannot disagree about what a
//     document mentions. A chip naming no account is expected to have no row.
//   - `extra`: a row whose chip its document no longer holds, or a row for a
//     DRAFT annotation, which has none.
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
  column: "doc_id" | "post_id" | "annotation_id";
  trigger: string;
  /** SQL over the source aliased `s`: the jsonb array of {iid, user_id} its rows should be. */
  wanted: string;
  /** `mention_sync`'s three id arguments for a source row aliased `s`. */
  syncArgs: string;
};

const SOURCES: Source[] = [
  {
    table: "doc",
    column: "doc_id",
    trigger: "doc_sync_mentions",
    wanted: "public.mentions_wanted(s.prose_json)",
    syncArgs: "s.id, NULL, NULL",
  },
  {
    table: "annotation",
    column: "annotation_id",
    trigger: "annotation_sync_mentions",
    wanted: "CASE WHEN s.status = 'DRAFT' THEN '[]'::jsonb ELSE public.mentions_wanted(s.prose_json) END",
    syncArgs: "NULL, NULL, s.id",
  },
  {
    table: "post",
    column: "post_id",
    trigger: "post_sync_mentions",
    wanted: "public.post_mentions_wanted(s.prose_json)",
    syncArgs: "NULL, s.id, NULL",
  },
];

type Drift = { source: string; id: string; iid: string; userId: string };
type Report = { triggers: string[]; missing: Drift[]; extra: Drift[] };

async function check(): Promise<Report> {
  const report: Report = { triggers: [], missing: [], extra: [] };

  for (const source of SOURCES) {
    const [trigger] = await prisma.$queryRawUnsafe<{ enabled: string }[]>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass AND NOT tgisinternal`,
      source.trigger,
      `"${source.table}"`,
    );
    if (!trigger) report.triggers.push(`${source.trigger} on ${source.table} does not exist`);
    else if (trigger.enabled === "D") report.triggers.push(`${source.trigger} on ${source.table} is disabled`);

    // What each source should have, joined to the accounts that exist: a chip
    // naming none has no row by design.
    const wanted = `
      SELECT s.id AS source_id, w.iid, w.user_id
      FROM "${source.table}" s
      CROSS JOIN LATERAL jsonb_to_recordset(${source.wanted}) AS w(iid text, user_id text)
      JOIN "user" u ON u.id = w.user_id
    `;
    const missing = await prisma.$queryRawUnsafe<{ source_id: string; iid: string; user_id: string }[]>(`
      SELECT w.source_id, w.iid, w.user_id FROM (${wanted}) w
      WHERE NOT EXISTS (
        SELECT 1 FROM "mention" m WHERE m.${source.column} = w.source_id AND m.iid = w.iid AND m.user_id = w.user_id
      )
    `);
    const extra = await prisma.$queryRawUnsafe<{ source_id: string; iid: string; user_id: string }[]>(`
      SELECT m.${source.column} AS source_id, m.iid, m.user_id FROM "mention" m
      WHERE m.${source.column} IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM (${wanted}) w WHERE w.source_id = m.${source.column} AND w.iid = m.iid AND w.user_id = m.user_id
      )
    `);
    const drift = (row: { source_id: string; iid: string; user_id: string }): Drift => ({
      source: source.table,
      id: row.source_id,
      iid: row.iid,
      userId: row.user_id,
    });
    report.missing.push(...missing.map(drift));
    report.extra.push(...extra.map(drift));
  }
  return report;
}

function print(report: Report): number {
  const count = report.triggers.length + report.missing.length + report.extra.length;
  for (const line of report.triggers) console.log(`  ERROR [trigger] ${line}`);
  for (const [name, rows] of [
    ["missing", report.missing],
    ["extra", report.extra],
  ] as const) {
    if (rows.length === 0) continue;
    const sources = new Set(rows.map((row) => `${row.source}:${row.id}`));
    console.log(`  ERROR [${name}] ${rows.length} row(s) across ${sources.size} source(s)`);
    if (verbose) for (const row of rows) console.log(`          ${row.source} ${row.id}  chip ${row.iid}  user ${row.userId}`);
  }
  return count;
}

async function repairIndex(report: Report) {
  for (const source of SOURCES) {
    const ids = [...new Set([...report.missing, ...report.extra].filter((row) => row.source === source.table).map((row) => row.id))];
    if (ids.length === 0) continue;
    await prisma.$queryRawUnsafe(
      // Cast to text: the function returns void, which the driver can't read back.
      `SELECT public.mention_sync(${source.syncArgs}, ${source.wanted})::text FROM "${source.table}" s WHERE s.id = ANY($1::text[])`,
      ids,
    );
    console.log(`  repaired ${ids.length} ${source.table}(s)`);
  }
}

async function main() {
  const [{ rows }] = await prisma.$queryRawUnsafe<{ rows: bigint }[]>(`SELECT count(*) AS rows FROM "mention"`);
  console.log(`\nmention index: ${rows} row(s)`);

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
