import { readFile } from "node:fs/promises";
import { prisma } from "./prisma";
import { storagePathFor } from "./file-storage";
import { currentTextVersion, extractPdf } from "./pdf-extract";

// docs/PDF.md §3 — a file version's stored page text at a given `textVersion`,
// extracted on first use when the version predates it.
//
// **Keyed by version, never by file** (docs/PDF.md §13, "Versions"): every
// function here takes a `file_version.id`, and a caller that means the latest
// passes `file.current_version_id`. The lazy extraction parses for seconds and
// then writes, so it writes under the version whose bytes it read, and never
// under "the file's latest" looked up afterwards: a promotion in between
// would otherwise put one version's text on another's bytes.
//
// Server-only (the `node:` import; see src/lib/file-storage.ts).
//
// **Why the lazy half exists.** Upload stores page text at the version current
// then, and nothing re-extracts it. After a `NORMALISER_VERSION` or pdfjs bump
// the browser measures offsets at the new version while every older file has
// rows only at the old one — so a plain lookup misses, and
// `capturePdfTextAnchor` would store every new anchor on every older file with
// an empty quote. Nothing refuses that; it just degrades, silently, on every
// annotation, tag, link and comment quote. Re-extracting here instead, the
// first time a version is asked for at the text version this server produces, closes
// the gap without a deploy step anyone has to remember.
//
// **Additive, never a rewrite.** The new rows go in beside the old ones, which
// stay: every anchor already stored names its own `textVersion`, and
// `scripts/integrity/check-pdf-anchors.ts` verifies it against exactly that
// extraction.

/**
 * The normalised text of one page at `textVersion`, or null if there is none
 * and cannot be — the version isn't the one this server produces, the page is
 * out of range, the version is gone, abandoned or isn't a PDF's, or its bytes
 * won't parse.
 */
export async function storedPageText(fileVersionId: string, pageIndex: number, textVersion: string): Promise<string | null> {
  const stored = await lookup(fileVersionId, pageIndex, textVersion);
  if (stored !== null) return stored;
  if (!(await extractIfMissing(fileVersionId, textVersion))) return null;
  return lookup(fileVersionId, pageIndex, textVersion);
}

async function lookup(fileVersionId: string, pageIndex: number, textVersion: string): Promise<string | null> {
  const row = await prisma.filePageText.findUnique({
    where: { fileVersionId_pageIndex_textVersion: { fileVersionId, pageIndex, textVersion } },
    select: { text: true },
  });
  return row?.text ?? null;
}

// One extraction per file version and text version in flight, so the several captures a
// single post can make (a comment quoting three passages of one PDF) share it
// rather than each parsing the file. A second process racing this one is
// handled by `skipDuplicates` instead.
const inFlight = new Map<string, Promise<boolean>>();

function extractIfMissing(fileVersionId: string, textVersion: string): Promise<boolean> {
  const key = `${fileVersionId}:${textVersion}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = extract(fileVersionId, textVersion).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

// True if rows at `textVersion` may now exist that didn't before.
async function extract(fileVersionId: string, textVersion: string): Promise<boolean> {
  // A client still running the previous build asks for the version before
  // this one, which this server cannot produce. Its capture keeps the quads
  // and drops the quote, as capturePdfTextAnchor documents.
  if (textVersion !== (await currentTextVersion())) return false;

  // Any row at this text version means the version was already extracted at
  // it, so the miss is a page index past the end, not a missing extraction.
  if ((await prisma.filePageText.count({ where: { fileVersionId, textVersion } })) > 0) return false;

  const version = await prisma.fileVersion.findUnique({
    where: { id: fileVersionId },
    select: { sha256: true, pageCount: true, abandonedAt: true },
  });
  // A null pageCount is a format with no page text at all (a .docx), and an
  // abandoned version has no bytes to read.
  if (!version || version.pageCount === null || version.abandonedAt !== null) return false;

  let parsed;
  try {
    parsed = await extractPdf(await readFile(storagePathFor(version.sha256)));
  } catch (err) {
    console.error(`[pdf-page-text] couldn't re-extract file version ${fileVersionId} at ${textVersion}:`, err);
    return false;
  }
  if (parsed.textVersion !== textVersion) return false;

  // Under the version whose bytes were just parsed: `fileVersionId` named
  // them before the parse, and a version's bytes never change.
  await prisma.filePageText.createMany({
    data: parsed.pages.map((text, pageIndex) => ({ fileVersionId, pageIndex, textVersion, text })),
    skipDuplicates: true,
  });
  console.log(`[pdf-page-text] extracted file version ${fileVersionId} at ${textVersion} (${parsed.pages.length} pages)`);
  return true;
}
