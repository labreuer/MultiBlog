// Verifies that every file has a latest version, and that the version it
// names is one a reader may be shown (docs/PDF.md §13, "Versions").
//
// **Why a check, when a foreign key already ties the two rows.** A file and
// its first version name each other, so `file.current_version_id` is nullable
// for the one step in which the file exists and its version doesn't yet —
// inside the transaction that makes both (`createFileWithFirstVersion`). The
// database therefore cannot say "every file has a latest version", and every
// reader of a file's bytes goes through `latestVersionOf`, which throws on a
// file without one. A file left that way is a broken page, a search query
// that throws and an MCP read that fails, and nothing reports it until
// someone opens that file. This is what makes it loud.
//
// What it checks, per file, soft-deleted files included (a restore brings
// one back):
//
//   - `no-latest`: `current_version_id` is NULL.
//   - `latest-not-promoted`: the latest version has no `promoted_at`. Only a
//     promotion may move the pointer, and it stamps the row in the same
//     transaction.
//   - `latest-abandoned`: the latest version is abandoned, so it has no bytes
//     and no page text.
//   - `no-version-1`: the file has no version numbered 1. Numbers are never
//     reused and start at 1, so every file has one.
//   - `number-gap`: the file's versions are not numbered 1 to their count. An
//     abandoned version keeps its row, so nothing should ever leave a gap.
//
// The pair foreign key already guarantees the latest is one of the file's own
// versions; scripts/integrity/check-tag-constraints.ts proves that key, the
// one-candidate index and the anchor CHECKs reject what they should.
//
// Usage:
//   npx tsx scripts/integrity/check-file-versions.ts [--file <fileIdOrSlug>] [--verbose]
//
// Exits non-zero on any ERROR.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";

let errors = 0;
let verbose = false;

function report(id: string, check: string, message: string): void {
  errors++;
  console.log(`ERROR  ${id}  [${check}] ${message}`);
}

function note(message: string): void {
  if (verbose) console.log(`       ${message}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  verbose = args.includes("--verbose");
  const fileArgIndex = args.indexOf("--file");
  const fileArg = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

  const files = await prisma.storedFile.findMany({
    where: fileArg ? { OR: [{ id: fileArg }, { slug: fileArg }] } : {},
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      slug: true,
      currentVersionId: true,
      versions: { orderBy: { number: "asc" }, select: { id: true, number: true, promotedAt: true, abandonedAt: true } },
    },
  });
  if (fileArg && files.length === 0) throw new Error(`No file with id or slug "${fileArg}".`);

  console.log(`Checking ${files.length} file(s)…\n`);

  for (const file of files) {
    const name = `${file.id} (${file.slug})`;
    if (file.currentVersionId === null) {
      report(name, "no-latest", "has no latest version: every read of its bytes throws");
    } else {
      // The pair key makes this one of `file.versions`.
      const latest = file.versions.find((version) => version.id === file.currentVersionId);
      if (latest && latest.promotedAt === null) {
        report(name, "latest-not-promoted", `its latest, version ${latest.number}, was never promoted`);
      }
      if (latest && latest.abandonedAt !== null) {
        report(name, "latest-abandoned", `its latest, version ${latest.number}, is abandoned and has no bytes`);
      }
    }

    const numbers = file.versions.map((version) => version.number);
    if (numbers[0] !== 1) {
      report(name, "no-version-1", `its versions are numbered ${numbers.join(", ") || "(none)"}`);
    } else if (numbers.some((number, index) => number !== index + 1)) {
      report(name, "number-gap", `its versions are numbered ${numbers.join(", ")}, not 1 to ${numbers.length}`);
    }

    note(`${name}: ${file.versions.length} version(s) ✓`);
  }

  console.log(`\n${files.length} file(s) checked. ${errors} error(s).`);
  if (errors > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
