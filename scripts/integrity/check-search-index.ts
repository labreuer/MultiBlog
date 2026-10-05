// Verifies the full-text search index (docs/FULLTEXT.md §3): that every
// `search_vector` is what its kind's SQL function says it should be, and that
// every lexeme in a vector is in the `search_lexeme` vocabulary.
//
// Why this needs a check at all: both are written by triggers
// (add_full_text_search) and read by nothing that would notice them being
// wrong. A vector written while its trigger was disabled, or by a load that
// went around it, is a search that silently misses; a lexeme missing from the
// vocabulary is a typo that silently goes uncorrected. `prose_json_length`
// has the same drift surface for the same reason, and check-doc-integrity's
// `length-cache` is its guard; this is the search index's.
//
// Four checks:
//
//   - `trigger`: every trigger the migration created exists and is enabled.
//     The other two checks cannot tell a disabled trigger from bad luck, and
//     `--repair` works by firing them.
//   - `vector`: each row's `search_vector` equals its function's output —
//     `doc_search_vector(title, prose_json)` and its five siblings. The check
//     calls the very function the trigger calls, so the two cannot disagree
//     about what the right vector is.
//   - `vocabulary`: every lexeme of every vector is a `search_lexeme` row.
//     The triggers add only what a statement introduced, relying on exactly
//     this being true beforehand, so a gap never closes by itself.
//   - `stale` (a WARN, `--verbose` lists them): vocabulary rows no vector
//     holds any more. Harmless — typo correction uses no candidate without a
//     readable hit — and the table never shrinks on its own; `--repair`
//     removes them.
//
// `--repair` re-fires the row triggers for every drifted row (a no-op UPDATE
// of a column the trigger names, docs/DATABASE.md's recipe) and then rebuilds
// the vocabulary from `ts_stat` under a lock that holds the triggers' own
// inserts off until it commits, so a save racing it cannot lose a lexeme.
// It refuses to run while a trigger is missing or disabled, since firing them
// would then fix nothing.
//
// Reads only without `--repair`; safe to run any time, including mid-editing,
// because a vector is written in the same statement as the text it is of —
// there is no legitimate lag to excuse.
//
// Usage:
//   npx tsx scripts/integrity/check-search-index.ts
//   ... --verbose        also list each drifted row and stale lexeme
//   ... --repair         fix what it finds, then check again
//
// Exits non-zero on any ERROR (a missing or disabled trigger, a drifted
// vector, a lexeme missing from the vocabulary). Stale lexemes alone exit
// zero.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const repair = args.includes("--repair");

// Every name below is a constant of this file and none is user input, which
// is what makes the $queryRawUnsafe calls that interpolate them safe.
type Kind = {
  table: string;
  /** How a drifted row is named in the report. */
  key: string;
  /** The kind's vector function, applied to the row's own columns. */
  vector: string;
  /** A column the row trigger names, for the no-op UPDATE that re-fires it. */
  touch: string;
};

const KINDS: Kind[] = [
  { table: "doc", key: "id", vector: "doc_search_vector(title, prose_json)", touch: "title" },
  { table: "post", key: "id", vector: "post_search_vector(title, prose_json)", touch: "title" },
  {
    table: "annotation",
    key: "id",
    vector: "annotation_search_vector(body_text, quoted_text)",
    touch: "body_text",
  },
  { table: "comment", key: "id", vector: "comment_search_vector(body_text)", touch: "body_text" },
  { table: "file", key: "id", vector: "file_search_vector(title, filename)", touch: "title" },
  {
    table: "file_page_text",
    key: "file_id || ' p' || page_index || ' @' || text_version",
    vector: "file_page_text_search_vector(text)",
    touch: "text",
  },
];

const EXPECTED_TRIGGERS = KINDS.flatMap(({ table }) => [
  { table, name: `${table}_sync_search_vector` },
  { table, name: `${table}_search_lexeme_insert` },
  { table, name: `${table}_search_lexeme_update` },
]);

/** Every vector in the database, as a query ts_stat can take. */
const ALL_VECTORS = KINDS.map(({ table }) => `SELECT search_vector FROM "${table}"`).join(" UNION ALL ");

type Report = {
  triggerFaults: string[];
  drifted: { table: string; keys: string[] }[];
  missingLexemes: string[];
  staleLexemes: string[];
};

async function inspect(): Promise<Report> {
  const triggers = await prisma.$queryRawUnsafe<{ table: string; name: string; enabled: string }[]>(
    `SELECT tgrelid::regclass::text AS table, tgname AS name, tgenabled::text AS enabled
     FROM pg_trigger WHERE NOT tgisinternal`,
  );
  const triggerFaults: string[] = [];
  for (const expected of EXPECTED_TRIGGERS) {
    const found = triggers.find((t) => t.table === expected.table && t.name === expected.name);
    if (!found) triggerFaults.push(`${expected.table}.${expected.name} is missing`);
    // 'O' is enabled in the ordinary (origin) replication role; 'D' is disabled.
    else if (found.enabled !== "O") triggerFaults.push(`${expected.table}.${expected.name} is not enabled (${found.enabled})`);
  }

  const drifted: Report["drifted"] = [];
  for (const kind of KINDS) {
    const rows = await prisma.$queryRawUnsafe<{ key: string }[]>(
      `SELECT ${kind.key} AS key FROM "${kind.table}"
       WHERE search_vector IS DISTINCT FROM ${kind.vector}
       ORDER BY 1`,
    );
    if (rows.length > 0) drifted.push({ table: kind.table, keys: rows.map((r) => r.key) });
  }

  const missing = await prisma.$queryRawUnsafe<{ lexeme: string }[]>(
    `SELECT s.word AS lexeme FROM ts_stat($q$${ALL_VECTORS}$q$) AS s
     WHERE NOT EXISTS (SELECT 1 FROM search_lexeme l WHERE l.lexeme = s.word)
     ORDER BY 1`,
  );
  const stale = await prisma.$queryRawUnsafe<{ lexeme: string }[]>(
    `SELECT l.lexeme FROM search_lexeme l
     WHERE NOT EXISTS (SELECT 1 FROM ts_stat($q$${ALL_VECTORS}$q$) AS s WHERE s.word = l.lexeme)
     ORDER BY 1`,
  );

  return {
    triggerFaults,
    drifted,
    missingLexemes: missing.map((r) => r.lexeme),
    staleLexemes: stale.map((r) => r.lexeme),
  };
}

function errorCount(report: Report): number {
  return (
    report.triggerFaults.length +
    report.drifted.reduce((sum, d) => sum + d.keys.length, 0) +
    report.missingLexemes.length
  );
}

function print(report: Report) {
  for (const fault of report.triggerFaults) {
    console.log(`  ERROR [trigger] ${fault}`);
  }
  for (const { table, keys } of report.drifted) {
    console.log(`  ERROR [vector] ${keys.length} ${table} row(s) whose search_vector is not their function's output`);
    if (verbose) for (const key of keys) console.log(`          ${key}`);
  }
  if (report.missingLexemes.length > 0) {
    const sample = report.missingLexemes.slice(0, 10).join(", ");
    console.log(
      `  ERROR [vocabulary] ${report.missingLexemes.length} lexeme(s) in a vector but not in search_lexeme` +
        (verbose ? `: ${report.missingLexemes.join(", ")}` : ` (e.g. ${sample})`),
    );
  }
  if (report.staleLexemes.length > 0) {
    console.log(
      `  WARN  [stale] ${report.staleLexemes.length} search_lexeme row(s) no vector holds any more` +
        (verbose ? `: ${report.staleLexemes.join(", ")}` : ""),
    );
  }
}

async function repairIndex(report: Report) {
  for (const { table } of report.drifted) {
    const kind = KINDS.find((k) => k.table === table)!;
    const count = await prisma.$executeRawUnsafe(
      `UPDATE "${kind.table}" SET "${kind.touch}" = "${kind.touch}"
       WHERE search_vector IS DISTINCT FROM ${kind.vector}`,
    );
    console.log(`  repaired ${count} ${kind.table} vector(s)`);
  }

  // EXCLUSIVE blocks every other writer of search_lexeme — which is every
  // vocabulary trigger — until commit, while reads go on. Each statement
  // below then sees every vector committed before the lock was granted, and
  // a save that commits after it adds its own new lexemes once the lock is
  // released, so nothing can fall between the delete and the insert.
  const [removed, added] = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE search_lexeme IN EXCLUSIVE MODE`);
    const removed = await tx.$executeRawUnsafe(
      `DELETE FROM search_lexeme l
       WHERE NOT EXISTS (SELECT 1 FROM ts_stat($q$${ALL_VECTORS}$q$) AS s WHERE s.word = l.lexeme)`,
    );
    const added = await tx.$executeRawUnsafe(
      `INSERT INTO search_lexeme (lexeme)
       SELECT word FROM ts_stat($q$${ALL_VECTORS}$q$) ORDER BY word
       ON CONFLICT DO NOTHING`,
    );
    return [removed, added];
  });
  console.log(`  vocabulary rebuilt: ${added} lexeme(s) added, ${removed} stale one(s) removed`);
}

async function main() {
  let report = await inspect();
  const vocabularySize = await prisma.searchLexeme.count();
  console.log(`search index: ${KINDS.length} vector columns, ${vocabularySize} vocabulary lexeme(s)`);
  print(report);

  if (repair && (errorCount(report) > 0 || report.staleLexemes.length > 0)) {
    if (report.triggerFaults.length > 0) {
      console.log("\nNot repairing: the repair fires the triggers, so a missing or disabled one has to be restored first.");
    } else {
      console.log("\nrepairing…");
      await repairIndex(report);
      report = await inspect();
      console.log("\nafter repair:");
      print(report);
    }
  }

  const errors = errorCount(report);
  console.log(errors === 0 ? "\nno errors" : `\n${errors} error(s)`);
  await prisma.$disconnect();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
