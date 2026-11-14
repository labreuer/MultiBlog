// Brings every PDF's stored page text up to the current `textVersion`, moves
// anchors onto it where that changes nothing, and deletes older extractions
// nothing points at any more.
//
// WHY
//
// Page text is stored at upload, stamped `${pdfjsVersion}/${NORMALISER_VERSION}`
// (src/lib/pdf-text.ts), and every PDF anchor names the version it was measured
// against. After either half changes, older files have text only at the old
// version. src/lib/pdf-page-text.ts already extracts a file version lazily the
// first time a capture asks for it at the new text version, so nothing *needs*
// this script; what it adds is doing that for every one at once, and the
// cleanup the lazy path deliberately never attempts.
//
// WHAT, per version of a PDF that has its bytes (docs/PDF.md §13: page text
// and anchors are a version's, and an abandoned version has no bytes to
// extract from; soft-deleted files included — a restore brings their anchors
// back). "Version" alone below is the text version.
//
//   1. Extract the file version at the current version if it has no rows there.
//   2. Every anchor on it at an older version — `annotation.pdf_target`,
//      and the PDF_TEXT selector of `tag_anchor`, `anchored_link_anchor` and
//      `comment_quote_anchor` — is moved to the current version when its page
//      reads *identically* at both. Then its offsets, quote and context are
//      true at the new version by construction, and only the stamp changes.
//      An anchor whose page differs keeps its old version: rewriting its
//      offsets is re-anchoring (docs/PDF.md §3), which this does not do.
//   3. An older version is deleted, all its pages, once no anchor names it.
//      While any anchor still does, every page of that version stays.
//
// Idempotent. Dry run is the default, per the convention the other backfills
// set: it still extracts (in memory, writing nothing), so it reports exactly
// what --apply would do.
//
// A browser still running the build before the bump posts at the old
// version, and the deletes are re-checked inside their transaction for that
// reason — but run it after the deploy has settled, not during it.
//
// **Each file's writes are made with its row locked** (`lockFile`), as a
// version's upload, promotion and abandoning are, and a note's move
// (docs/PDF.md §13, "Earlier versions"). What an anchor holds is read
// before the transaction, so a write also names the version the anchor was
// on then: one that has left it since is not written back over. The page
// text of a version abandoned while the script ran is not written either.
//
// Usage:
//   npx tsx scripts/upgrade-pdf-text-version.ts            # dry run
//   npx tsx scripts/upgrade-pdf-text-version.ts --apply
//
// Afterwards, scripts/integrity/check-pdf-anchors.ts verifies every anchor
// against the extraction it now names.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import type { Prisma } from "../src/generated/prisma/client";
import { prismaIncludingDeleted as prisma } from "../src/lib/prisma";
import { storagePathFor } from "../src/lib/file-storage";
import { currentTextVersion, extractPdf } from "../src/lib/pdf-extract";
import { parsePdfTarget } from "../src/lib/pdf-anchor";

type AnchorTable = "annotation" | "tag_anchor" | "anchored_link_anchor" | "comment_quote_anchor";

type AnchorRef = {
  table: AnchorTable;
  id: string;
  /** The stored blob as-is, so a rewrite keeps any field this script doesn't know about. */
  raw: Record<string, unknown>;
  pageIndex: number;
  textVersion: string;
};

type Tx = Prisma.TransactionClient;

// Every anchor with a PDF target names its version (`file_version_id`), so
// the anchors on one are found by it.
async function anchorsOn(fileVersionId: string): Promise<AnchorRef[]> {
  const [annotations, tags, links, quotes] = await Promise.all([
    prisma.annotation.findMany({ where: { fileVersionId }, select: { id: true, pdfTarget: true } }),
    prisma.tagAnchor.findMany({ where: { fileVersionId, selectorKind: "PDF_TEXT" }, select: { id: true, selector: true } }),
    prisma.anchoredLinkAnchor.findMany({
      where: { fileVersionId, selectorKind: "PDF_TEXT" },
      select: { id: true, selector: true },
    }),
    prisma.commentQuoteAnchor.findMany({
      where: { fileVersionId, selectorKind: "PDF_TEXT" },
      select: { id: true, selector: true },
    }),
  ]);

  const refs: AnchorRef[] = [];
  const add = (table: AnchorTable, id: string, blob: unknown) => {
    // Unparseable blobs are the integrity check's business; here they simply
    // name no version, so they neither move nor hold one in place.
    const target = parsePdfTarget(blob);
    if (!target) return;
    refs.push({ table, id, raw: blob as Record<string, unknown>, pageIndex: target.pageIndex, textVersion: target.textVersion });
  };
  for (const a of annotations) if (a.pdfTarget !== null) add("annotation", a.id, a.pdfTarget);
  for (const t of tags) add("tag_anchor", t.id, t.selector);
  for (const l of links) add("anchored_link_anchor", l.id, l.selector);
  for (const q of quotes) add("comment_quote_anchor", q.id, q.selector);
  return refs;
}

/**
 * Restamps one anchor, **where it is still on the version it was read on**:
 * `ref.raw` is what the row held before the transaction, and an anchor that
 * has been given another version's target since must not have this one
 * written back over it. Answers whether it wrote.
 */
async function moveAnchor(tx: Tx, ref: AnchorRef, fileVersionId: string, textVersion: string): Promise<boolean> {
  const blob = { ...ref.raw, textVersion } as Prisma.InputJsonValue;
  const where = { id: ref.id, fileVersionId };
  switch (ref.table) {
    case "annotation":
      return (await tx.annotation.updateMany({ where, data: { pdfTarget: blob } })).count > 0;
    case "tag_anchor":
      return (await tx.tagAnchor.updateMany({ where, data: { selector: blob } })).count > 0;
    case "anchored_link_anchor":
      return (await tx.anchoredLinkAnchor.updateMany({ where, data: { selector: blob } })).count > 0;
    case "comment_quote_anchor":
      return (await tx.commentQuoteAnchor.updateMany({ where, data: { selector: blob } })).count > 0;
  }
}

/**
 * Locks a file's row for the rest of `tx`, and answers whether the version
 * still has its bytes: one abandoned since the run began has none, and takes
 * no page text.
 */
async function lockFile(tx: Tx, fileId: string, fileVersionId: string): Promise<boolean> {
  await tx.$queryRaw`SELECT 1 FROM "file" WHERE "id" = ${fileId} FOR UPDATE`;
  const version = await tx.fileVersion.findUnique({ where: { id: fileVersionId }, select: { abandonedAt: true } });
  return version !== null && version.abandonedAt === null;
}

// Straight from the database rather than from `anchorsOn`'s snapshot, so a
// row posted at this version since the snapshot still keeps its text.
async function referencesTo(tx: Tx, fileVersionId: string, textVersion: string): Promise<number> {
  const bySelector = { fileVersionId, selectorKind: "PDF_TEXT" as const, selector: { path: ["textVersion"], equals: textVersion } };
  const counts = await Promise.all([
    tx.annotation.count({ where: { fileVersionId, pdfTarget: { path: ["textVersion"], equals: textVersion } } }),
    tx.tagAnchor.count({ where: bySelector }),
    tx.anchoredLinkAnchor.count({ where: bySelector }),
    tx.commentQuoteAnchor.count({ where: bySelector }),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

const MB = 1024 * 1024;

function progress(pagesDone: number, pagesTotal: number, filesDone: number, filesTotal: number, bytesDone: number, bytesTotal: number): string {
  const percent = pagesTotal === 0 ? 100 : (100 * pagesDone) / pagesTotal;
  const width = String(filesTotal).length;
  // A second decimal below 10 MB, or a handful of small PDFs reads "0.0/0.0".
  const digits = bytesTotal < 10 * MB ? 2 : 1;
  const mbTotal = (bytesTotal / MB).toFixed(digits);
  return (
    `[${percent.toFixed(1).padStart(5)}% pages · ` +
    `${String(filesDone).padStart(width)}/${filesTotal} files · ` +
    `${(bytesDone / MB).toFixed(digits).padStart(mbTotal.length)}/${mbTotal} MB]`
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const current = await currentTextVersion();

  const versions = await prisma.fileVersion.findMany({
    // A null pageCount is a format with no page text (a .docx), and an
    // abandoned version has no bytes.
    where: { pageCount: { not: null }, abandonedAt: null },
    orderBy: [{ file: { createdAt: "asc" } }, { number: "asc" }],
    select: {
      id: true,
      fileId: true,
      number: true,
      filename: true,
      sha256: true,
      byteSize: true,
      pageCount: true,
      file: { select: { deletedAt: true, currentVersionId: true } },
    },
  });
  const files = versions.map(({ file: owner, ...version }) => ({
    ...version,
    // A version other than the latest is named as one, as its page is.
    name: `${version.filename}${version.id === owner.currentVersionId ? "" : `, version ${version.number}`}${owner.deletedAt ? " (deleted)" : ""}`,
  }));

  const pagesTotal = files.reduce((sum, f) => sum + (f.pageCount ?? 0), 0);
  const bytesTotal = files.reduce((sum, f) => sum + f.byteSize, 0);
  console.log(
    `${apply ? "Applying" : "Dry run (pass --apply to write)"} — current textVersion ${current}; ` +
      `${files.length} PDF(s), ${pagesTotal} page(s), ${(bytesTotal / MB).toFixed(1)} MB\n`,
  );

  let pagesDone = 0;
  let bytesDone = 0;
  let failures = 0;
  const totals = { extracted: 0, moved: 0, kept: 0, deletedVersions: 0, deletedRows: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const notes: string[] = [];

    try {
      const rows = await prisma.filePageText.findMany({
        where: { fileVersionId: file.id },
        select: { textVersion: true, pageIndex: true, text: true },
      });
      const textAt = new Map<string, Map<number, string>>();
      for (const row of rows) {
        let pages = textAt.get(row.textVersion);
        if (!pages) textAt.set(row.textVersion, (pages = new Map()));
        pages.set(row.pageIndex, row.text);
      }

      // 1 — the current extraction, from the database or freshly made.
      let currentPages = textAt.get(current);
      if (!currentPages) {
        const parsed = await extractPdf(await readFile(storagePathFor(file.sha256)));
        if (parsed.textVersion !== current) {
          throw new Error(`extraction stamped ${parsed.textVersion}, expected ${current}`);
        }
        if (apply) {
          await prisma.$transaction(
            async (tx) => {
              if (!(await lockFile(tx, file.fileId, file.id))) throw new Error("abandoned while this ran; it has no bytes to extract from");
              await tx.filePageText.createMany({
                data: parsed.pages.map((text, pageIndex) => ({ fileVersionId: file.id, pageIndex, textVersion: current, text })),
                skipDuplicates: true,
              });
            },
            { timeout: 60_000 },
          );
        }
        currentPages = new Map(parsed.pages.map((text, pageIndex) => [pageIndex, text]));
        totals.extracted++;
        notes.push(`${apply ? "extracted" : "would extract"} ${parsed.pages.length} page(s)`);
      }

      // 2 — which older anchors can move.
      const older = (await anchorsOn(file.id)).filter((ref) => ref.textVersion !== current);
      const movable: AnchorRef[] = [];
      const held = new Map<string, number>();
      for (const ref of older) {
        const before = textAt.get(ref.textVersion)?.get(ref.pageIndex);
        const after = currentPages.get(ref.pageIndex);
        if (before !== undefined && before === after) {
          movable.push(ref);
        } else {
          held.set(ref.textVersion, (held.get(ref.textVersion) ?? 0) + 1);
        }
      }

      // 3 — older versions nothing will name once the moves land.
      const deletable = [...textAt.keys()].filter((v) => v !== current && !held.has(v));

      if (apply && (movable.length > 0 || deletable.length > 0)) {
        await prisma.$transaction(
          async (tx) => {
            await lockFile(tx, file.fileId, file.id);
            for (const ref of movable) await moveAnchor(tx, ref, file.id, current);
            for (const version of deletable) {
              if ((await referencesTo(tx, file.id, version)) > 0) continue;
              const { count } = await tx.filePageText.deleteMany({ where: { fileVersionId: file.id, textVersion: version } });
              totals.deletedRows += count;
            }
          },
          { timeout: 60_000 },
        );
      } else if (!apply) {
        for (const version of deletable) totals.deletedRows += textAt.get(version)?.size ?? 0;
      }

      totals.moved += movable.length;
      if (movable.length > 0) notes.push(`${apply ? "moved" : "would move"} ${movable.length} anchor(s)`);
      for (const [version, count] of held) {
        totals.kept++;
        notes.push(`kept ${version} — ${count} anchor(s) on a page whose text changed`);
      }
      totals.deletedVersions += deletable.length;
      if (deletable.length > 0) notes.push(`${apply ? "deleted" : "would delete"} ${deletable.join(", ")}`);
    } catch (err) {
      failures++;
      notes.push(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    pagesDone += file.pageCount ?? 0;
    bytesDone += file.byteSize;
    console.log(
      `${progress(pagesDone, pagesTotal, i + 1, files.length, bytesDone, bytesTotal)} ${file.name} — ` +
        (notes.length > 0 ? notes.join("; ") : "up to date"),
    );
  }

  const verb = apply ? "" : "would be ";
  console.log(
    `\n${totals.extracted} file(s) ${verb}extracted, ${totals.moved} anchor(s) ${verb}moved, ` +
      `${totals.deletedVersions} old version(s) ${verb}deleted (${totals.deletedRows} row(s)), ` +
      `${totals.kept} old version(s) kept for anchors on changed pages, ${failures} failure(s).`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
