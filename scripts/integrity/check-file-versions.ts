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
//   - `no-bytes`: a version that is not abandoned has no bytes on disk.
//     Abandoning removes a blob before its transaction commits, under a lock
//     on the hash that every upload takes (docs/PDF.md §13, "The upload"), so
//     this is a commit that failed after the removal, a restored database
//     without its FILE_STORAGE_DIR, or a write that skipped the lock. A
//     second abandoning clears a candidate left this way.
//   - `abandoned-with-text`: an abandoned version still has page text. Its
//     bytes are gone, so nothing could have extracted it since.
//
// And over every anchor into a file (`annotation`, `tag_anchor`,
// `anchored_link_anchor`, `comment_quote_anchor`):
//
//   - `anchor-without-version`: a row with a PDF target names no version. The
//     tables' CHECKs refuse it; this is the same claim read back.
//   - `anchor-on-candidate`, `anchor-on-abandoned`: a row names a version
//     that was never promoted, or was abandoned. A capture checks its version
//     inside the transaction that inserts it (`assertCaptureVersion`), and a
//     candidate takes no note or link part, since abandoning it removes the
//     sheets the anchor was measured on. Nothing else reports one that got
//     through.
//   - `unmoved-kind`: a `tag_anchor` or `comment_quote_anchor` row holds a
//     `PDF_TEXT` selector on a file with more than one version. Neither has a
//     writer of one today, and nothing would move such a row forward, so one
//     appearing means a writer was added without its place in the move
//     (docs/PDF.md §13, "Placing each anchor").
//
// Over every page map (docs/PDF.md §13, "Matching the pages"), a link being
// carried through each one it meets and landing where the map says:
//
//   - `map-unreadable`: a version's `page_map` is not a map (`parsePageMap`).
//     Every reader takes such a value for no map, so links stop being carried
//     there and nothing says why.
//   - `map-without-base`: a version holds a map and names no base. A map is
//     between a version and its base.
//   - `map-fault`: the map is of another number of sheets than its base has,
//     or onto another number than its version has; two sheets of the base
//     have one counterpart; an accepted run of sheets is not written in, or
//     one that isn't accepted has a sheet paired (`pageMapFaults`).
//
// Over every row of `file_anchor_move` (§13, "Moving a note forward"), the
// moves and the "stays here" marks apart: a mark is a row that reaches no
// version, and is in none of the move checks.
//
//   - `move-off-file`: a move or a mark names a version that is not one of
//     its anchor's file's, or its anchor is into no file.
//   - `move-to-unpromoted`: a move reached a version that was never promoted,
//     or was abandoned.
//   - `move-not-forward`: a move reached a version that is not later than the
//     one it left.
//   - `move-chain-broken`: a move left another version than the one its
//     anchor's move before it reached. Undoing a move puts the anchor back on
//     the version the row says it left, so a row that is wrong about that
//     undoes to the wrong place.
//   - `anchor-not-where-moved`: an anchor is not on the version its newest
//     move reached. Newest is by `id`, which is from a sequence, never by
//     `moved_at`: two moves in one transaction share a time.
//   - `mark-off-version`: a mark names another version than the one its
//     anchor is on. A move of a marked note takes the mark off in its own
//     transaction, so a mark left behind is a write that went round it.
//   - `mark-on-latest`: a mark names its file's latest version, where there
//     is nothing to stay behind from.
//   - `two-marks`: an anchor has two marks. The table's partial unique
//     indexes refuse it; this is the same claim read back.
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
import { Prisma } from "../../src/generated/prisma/client";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";
import { storedByteSize } from "../../src/lib/file-storage";
import { pageMapFaults, parsePageMap } from "../../src/lib/pdf-page-map";

let errors = 0;
let maps = 0;
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
      versions: {
        orderBy: { number: "asc" },
        select: {
          id: true,
          number: true,
          sha256: true,
          promotedAt: true,
          abandonedAt: true,
          pageCount: true,
          baseVersionId: true,
          pageMap: true,
          _count: { select: { pageTexts: true } },
        },
      },
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

    for (const version of file.versions) {
      if (version.abandonedAt === null) {
        if ((await bytesOf(version.sha256)) === null) {
          report(name, "no-bytes", `version ${version.number} has no bytes on disk (${version.sha256.slice(0, 12)}…)`);
        }
      } else if (version._count.pageTexts > 0) {
        report(name, "abandoned-with-text", `version ${version.number} is abandoned and still has ${version._count.pageTexts} row(s) of page text`);
      }

      // An abandoned version keeps its map, and a link that names it is still carried through it.
      if (version.pageMap !== null) {
        maps++;
        const map = parsePageMap(version.pageMap);
        const base = file.versions.find((other) => other.id === version.baseVersionId);
        if (!map) {
          report(name, "map-unreadable", `version ${version.number}'s page map is not one: every reader takes it for no map`);
        } else if (!base) {
          report(name, "map-without-base", `version ${version.number} holds a page map and names no base for it to be from`);
        } else {
          for (const fault of pageMapFaults(map, { base: base.pageCount, version: version.pageCount })) {
            report(name, "map-fault", `version ${version.number}'s page map, from version ${base.number}: ${fault}`);
          }
        }
      }
    }

    note(`${name}: ${file.versions.length} version(s) ✓`);
  }

  console.log(`\n${maps} page map(s) checked.`);

  const fileIds = fileArg ? files.map((file) => file.id) : null;
  await checkAnchors(fileIds);
  await checkMoves(fileIds);

  console.log(`\n${files.length} file(s) checked. ${errors} error(s).`);
  if (errors > 0) process.exitCode = 1;
}

// Several versions routinely share a blob, so each hash is looked for once.
const bytesSeen = new Map<string, Promise<number | null>>();
function bytesOf(sha256: string): Promise<number | null> {
  let pending = bytesSeen.get(sha256);
  if (!pending) bytesSeen.set(sha256, (pending = storedByteSize(sha256)));
  return pending;
}

/** The four tables whose rows can hold a PDF target, and how each says that it does. */
const ANCHOR_TABLES = [
  { table: "annotation", holdsPdfTarget: Prisma.sql`a.pdf_target IS NOT NULL`, mustNotOutliveOneVersion: false },
  { table: "tag_anchor", holdsPdfTarget: Prisma.sql`a.selector_kind = 'PDF_TEXT'`, mustNotOutliveOneVersion: true },
  { table: "anchored_link_anchor", holdsPdfTarget: Prisma.sql`a.selector_kind = 'PDF_TEXT'`, mustNotOutliveOneVersion: false },
  { table: "comment_quote_anchor", holdsPdfTarget: Prisma.sql`a.selector_kind = 'PDF_TEXT'`, mustNotOutliveOneVersion: true },
] as const;

type AnchorFault = { id: string; fileId: string; number: number | null; promoted: boolean | null; abandoned: boolean | null; versions: number };

/** Every anchor into a file, against the version it names. `fileIds` narrows it to `--file`'s. */
async function checkAnchors(fileIds: string[] | null): Promise<void> {
  let anchors = 0;
  for (const { table, holdsPdfTarget, mustNotOutliveOneVersion } of ANCHOR_TABLES) {
    const rows = await prisma.$queryRaw<AnchorFault[]>(Prisma.sql`
      SELECT a.id::text AS id, a.file_id AS "fileId", v.number, (v.promoted_at IS NOT NULL) AS promoted, (v.abandoned_at IS NOT NULL) AS abandoned,
             (SELECT count(*)::int FROM file_version n WHERE n.file_id = a.file_id) AS versions
      FROM ${Prisma.raw(`"${table}"`)} a
      LEFT JOIN file_version v ON v.id = a.file_version_id
      WHERE ${holdsPdfTarget} ${fileIds ? Prisma.sql`AND a.file_id = ANY(${fileIds})` : Prisma.empty}`);
    anchors += rows.length;
    for (const row of rows) {
      const name = `${table} ${row.id}`;
      if (row.number === null) {
        report(name, "anchor-without-version", `holds a PDF target into file ${row.fileId} and names no version of it`);
        continue;
      }
      if (row.abandoned) report(name, "anchor-on-abandoned", `is on version ${row.number} of file ${row.fileId}, which was abandoned and has no sheets`);
      else if (!row.promoted) report(name, "anchor-on-candidate", `is on version ${row.number} of file ${row.fileId}, which was never promoted`);
      if (mustNotOutliveOneVersion && row.versions > 1) {
        report(name, "unmoved-kind", `holds a PDF_TEXT selector on file ${row.fileId}, which has ${row.versions} versions, and nothing moves a row of this table forward`);
      }
    }
  }
  console.log(`\n${anchors} anchor(s) with a PDF target checked.`);
}

type MoveRow = {
  id: string;
  anchor: string;
  anchorFileId: string | null;
  anchorVersionId: string | null;
  fromVersionId: string;
  fromFileId: string;
  fromNumber: number;
  fromIsLatest: boolean;
  toVersionId: string | null;
  toFileId: string | null;
  toNumber: number | null;
  toPromoted: boolean | null;
  toAbandoned: boolean | null;
};

/**
 * Every move and every "stays here" mark, against the anchor it is of and
 * the versions it names. `fileIds` narrows it to the anchors into `--file`'s.
 *
 * An anchor's rows are read in the order of their ids, which is the order
 * they were written in; a mark is the row with no `to_version_id`.
 */
async function checkMoves(fileIds: string[] | null): Promise<void> {
  const rows = await prisma.$queryRaw<MoveRow[]>(Prisma.sql`
    SELECT m.id::text AS id,
           CASE WHEN m.annotation_id IS NOT NULL THEN 'annotation ' || m.annotation_id ELSE 'anchored_link_anchor ' || m.anchored_link_anchor_id END AS anchor,
           COALESCE(a.file_id, p.file_id) AS "anchorFileId",
           COALESCE(a.file_version_id, p.file_version_id) AS "anchorVersionId",
           m.from_version_id AS "fromVersionId", fv.file_id AS "fromFileId", fv.number AS "fromNumber",
           (f.current_version_id = fv.id) AS "fromIsLatest",
           m.to_version_id AS "toVersionId", tv.file_id AS "toFileId", tv.number AS "toNumber",
           (tv.promoted_at IS NOT NULL) AS "toPromoted", (tv.abandoned_at IS NOT NULL) AS "toAbandoned"
    FROM file_anchor_move m
    LEFT JOIN annotation a ON a.id = m.annotation_id
    LEFT JOIN anchored_link_anchor p ON p.id = m.anchored_link_anchor_id
    JOIN file_version fv ON fv.id = m.from_version_id
    JOIN file f ON f.id = fv.file_id
    LEFT JOIN file_version tv ON tv.id = m.to_version_id
    ${fileIds ? Prisma.sql`WHERE COALESCE(a.file_id, p.file_id) = ANY(${fileIds}) OR fv.file_id = ANY(${fileIds})` : Prisma.empty}
    ORDER BY m.id`);

  const byAnchor = new Map<string, MoveRow[]>();
  for (const row of rows) byAnchor.set(row.anchor, [...(byAnchor.get(row.anchor) ?? []), row]);

  let moves = 0;
  let marks = 0;
  for (const [anchor, own] of byAnchor) {
    for (const row of own) {
      const name = `file_anchor_move ${row.id}`;
      const what = row.toVersionId === null ? "mark" : "move";
      if (row.anchorFileId === null) {
        report(name, "move-off-file", `is a ${what} of ${anchor}, which is into no file`);
      } else if (row.fromFileId !== row.anchorFileId || (row.toFileId !== null && row.toFileId !== row.anchorFileId)) {
        report(name, "move-off-file", `is a ${what} of ${anchor}, which is into file ${row.anchorFileId}, and names a version of another file`);
      }
    }

    const moved = own.filter((row) => row.toVersionId !== null);
    moves += moved.length;
    moved.forEach((row, index) => {
      const name = `file_anchor_move ${row.id}`;
      if (row.toAbandoned) report(name, "move-to-unpromoted", `moved ${anchor} to version ${row.toNumber}, which was abandoned and has no sheets`);
      else if (!row.toPromoted) report(name, "move-to-unpromoted", `moved ${anchor} to version ${row.toNumber}, which was never promoted`);
      // Numbers order one file's versions; across two files `move-off-file` has said what is wrong.
      if (row.toFileId === row.fromFileId && row.toNumber! <= row.fromNumber) {
        report(name, "move-not-forward", `moved ${anchor} from version ${row.fromNumber} to version ${row.toNumber}, which is not later`);
      }
      const before = moved[index - 1];
      if (before && before.toVersionId !== row.fromVersionId) {
        report(name, "move-chain-broken", `says ${anchor} left version ${row.fromNumber}, and the move before it (${before.id}) reached version ${before.toNumber}`);
      }
    });
    const newest = moved.at(-1);
    if (newest && newest.anchorVersionId !== newest.toVersionId) {
      report(anchor, "anchor-not-where-moved", `is not on version ${newest.toNumber}, which its newest move (${newest.id}) reached`);
    }

    const marked = own.filter((row) => row.toVersionId === null);
    marks += marked.length;
    if (marked.length > 1) report(anchor, "two-marks", `has ${marked.length} "stays here" marks (${marked.map((row) => row.id).join(", ")})`);
    for (const row of marked) {
      const name = `file_anchor_move ${row.id}`;
      if (row.anchorVersionId !== row.fromVersionId) report(name, "mark-off-version", `marks ${anchor} as staying on version ${row.fromNumber}, which it is not on`);
      if (row.fromIsLatest) report(name, "mark-on-latest", `marks ${anchor} as staying on version ${row.fromNumber}, which is its file's latest`);
    }
  }
  console.log(`${moves} move(s) and ${marks} "stays here" mark(s) checked.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
