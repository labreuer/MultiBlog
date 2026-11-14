import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api/errors";
import { storagePathFor } from "@/lib/file-storage";
import { lockFileRow } from "@/lib/file-version-data";
import { currentTextVersion, readSheetsInk } from "@/lib/pdf-extract";
import { skeletonOf } from "@/lib/pdf-fragment";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { usablePageLabels } from "@/lib/pdf-page-labels";
import { answerRun, parsePageMap, type PageMap } from "@/lib/pdf-page-map";
import { pairSheets, type SheetFacts, type VersionSheets } from "@/lib/pdf-page-map-pairing";
import { hasRunsToCompare } from "@/lib/pdf-sheet-alike";
import { prisma, type TransactionClient } from "@/lib/prisma";

// docs/PDF.md §13, "Matching the pages" — the server half of a page map:
// reading what the pairing rules take from a version's stored page text, its
// labels and its bytes, and storing a map or an answer to one of its runs.
//
// **A map is stored by a deliberate act, and once.** `workOutPageMap` stores
// nothing: a look at what a carry would do works on maps it builds and throws
// away. `storePageMap` writes one only where the version has none, with the
// file row locked, so two requests can't each store one. Nothing rebuilds a
// map or takes one away.
//
// No gate is here. The acts a person makes are `src/lib/file-manage.ts`'s,
// which ask `canUserManageFile` first.
//
// Server-only (Prisma, `node:fs`).

/** A version as the builder takes it. */
export type MapSource = { id: string; sha256: string; pageCount: number | null };

/**
 * What the pairing rules read of one version: each sheet's skeleton, own
 * label and, for a sheet without text, whether it draws anything.
 *
 * **From the stored page text**, at the current text version where the
 * version has it and at the greatest it has otherwise, as the fragment check
 * reads: a skeleton barely depends on the text version. **Only a sheet
 * without text has the document opened**, for the blank-sheet read
 * (`readSheetsInk`), which decodes images and takes seconds on a scan.
 */
export async function sheetFactsOf(version: MapSource): Promise<VersionSheets> {
  if (version.pageCount === null) throw new ApiError("invalid", "That version isn't a PDF, so it has no sheets to match.");
  const texts = await sheetTextsOf(version.id, null);
  const skeletons = Array.from({ length: version.pageCount }, (_, index) => skeletonOf(texts.get(index) ?? "").text);
  const ownLabels = (await pdfMetadata(version.id))?.pageLabels ?? [];

  const wordless = skeletons.flatMap((skeleton, index) => (hasRunsToCompare(skeleton) ? [] : [index]));
  // A document that can't be read leaves every such sheet as one with ink:
  // nothing is then taken for a blank sheet, and the map pairs less.
  const ink =
    wordless.length === 0
      ? new Map<number, boolean>()
      : await readFile(storagePathFor(version.sha256))
          .then((bytes) => readSheetsInk(bytes, wordless))
          .catch((error: unknown) => {
            console.error(`[pdf-page-map] couldn't read which sheets of file version ${version.id} draw nothing:`, error);
            return new Map<number, boolean>();
          });
  const sheets: SheetFacts[] = skeletons.map((skeleton, index) => ({ skeleton, label: ownLabels[index] ?? "", ink: ink.get(index) ?? true }));
  return { sheets, usableLabels: usablePageLabels(ownLabels, version.pageCount) !== null };
}

/**
 * A version's stored page text, by 0-based sheet: every sheet for null, or
 * the ones asked for. At the current text version where the version has it,
 * and at the greatest it has otherwise.
 */
export async function sheetTextsOf(fileVersionId: string, indexes: readonly number[] | null): Promise<Map<number, string>> {
  const texts = new Map<number, string>();
  if (indexes?.length === 0) return texts;
  const held = (await prisma.filePageText.groupBy({ by: ["textVersion"], where: { fileVersionId } })).map((row) => row.textVersion);
  const current = await currentTextVersion();
  const textVersion = held.includes(current) ? current : (held.sort().at(-1) ?? null);
  if (textVersion === null) return texts;
  const rows = await prisma.filePageText.findMany({
    where: { fileVersionId, textVersion, ...(indexes ? { pageIndex: { in: [...indexes] } } : {}) },
    select: { pageIndex: true, text: true },
  });
  for (const row of rows) texts.set(row.pageIndex, row.text);
  return texts;
}

const VERSION_FOR_MAP = {
  id: true,
  fileId: true,
  number: true,
  sha256: true,
  pageCount: true,
  abandonedAt: true,
  pageMap: true,
  baseVersion: { select: { id: true, number: true, sha256: true, pageCount: true, abandonedAt: true } },
} as const satisfies Prisma.FileVersionSelect;

type VersionForMap = Prisma.FileVersionGetPayload<{ select: typeof VERSION_FOR_MAP }>;

async function versionForMap(versionId: string): Promise<VersionForMap> {
  const version = await prisma.fileVersion.findUnique({ where: { id: versionId }, select: VERSION_FOR_MAP });
  if (!version) throw new ApiError("not_found", "That version doesn't exist.");
  return version;
}

/** Each version's sheets as they were read, by its id: what several maps worked out together share. */
export type SheetFactsRead = Map<string, Promise<VersionSheets>>;

/**
 * The page map between a version and its base, worked out and **not
 * stored**. Refused for a first version, which has no base to be matched
 * with, and for an abandoned one, whose text is gone.
 *
 * **`read` is for a caller that works out several maps of one file.** A
 * version between two others is the version of one map and the base of the
 * next, and with one `read` handed to each call its sheets are read, and its
 * document opened, once for both.
 */
export async function workOutPageMap(versionId: string, read: SheetFactsRead = new Map()): Promise<{ map: PageMap; version: VersionForMap }> {
  const version = await versionForMap(versionId);
  if (!version.baseVersion) throw new ApiError("invalid", `Version ${version.number} is this file's first, so there is no earlier version to match its sheets with.`);
  if (version.abandonedAt !== null) throw new ApiError("conflict", `Version ${version.number} was abandoned, and its text is gone, so its sheets can't be matched now.`);
  const factsOf = (source: MapSource): Promise<VersionSheets> => {
    const held = read.get(source.id);
    if (held) return held;
    const facts = sheetFactsOf(source);
    read.set(source.id, facts);
    return facts;
  };
  const [base, own] = await Promise.all([factsOf(version.baseVersion), factsOf(version)]);
  return { map: pairSheets(base, own), version };
}

/** A map as its column takes it. */
export function pageMapColumn(map: PageMap): Prisma.InputJsonValue {
  return map as unknown as Prisma.InputJsonValue;
}

/**
 * The map a version's row holds, or null where it holds none. **A stored
 * value that is no map is not "none"**: every reader takes it for no map, but
 * a write over it would store a second one and lose whatever answers the
 * first held, so it is refused, for `check-file-versions.ts` to name
 * (`map-unreadable`).
 */
function standingMap(pageMap: unknown): PageMap | null {
  const standing = parsePageMap(pageMap);
  if (!standing && pageMap !== null && pageMap !== undefined) {
    throw new ApiError("conflict", "This version has a stored page map that can't be read, and nothing is written over it. The integrity check for file versions names it.");
  }
  return standing;
}

/**
 * Writes a version's map **where it has none**, inside `tx`, which holds the
 * file row's lock (`lockFileRow`). Answers the map the version then has: the
 * one given, or the one another request stored first, which stands.
 */
export async function writePageMapIfNone(
  tx: TransactionClient,
  versionId: string,
  map: PageMap,
  by: { userId: string; carryId?: string | null },
): Promise<{ map: PageMap; stored: boolean }> {
  const row = await tx.fileVersion.findUnique({ where: { id: versionId }, select: { pageMap: true } });
  if (!row) throw new ApiError("not_found", "That version doesn't exist.");
  const standing = standingMap(row.pageMap);
  if (standing) return { map: standing, stored: false };
  await tx.fileVersion.update({
    where: { id: versionId },
    data: { pageMap: pageMapColumn(map), pageMapStoredAt: new Date(), pageMapStoredByUserId: by.userId, pageMapCarryId: by.carryId ?? null },
  });
  return { map, stored: true };
}

// A map's write waits for the file row as a version's other writes do
// (`VERSION_WRITE_TIMEOUTS`, file-manage.ts).
const MAP_WRITE_TIMEOUTS = { maxWait: 30_000, timeout: 60_000 } as const;

/**
 * Works out a version's map and stores it, where the version has none. The
 * working-out reads two versions' text and may open their documents, so it
 * comes first and outside the transaction; the write then checks, under the
 * file row's lock, that no other request stored one meanwhile.
 */
export async function storePageMap(versionId: string, by: { userId: string }): Promise<{ map: PageMap; stored: boolean; fileId: string; number: number }> {
  const existing = await versionForMap(versionId);
  const standing = standingMap(existing.pageMap);
  if (standing) return { map: standing, stored: false, fileId: existing.fileId, number: existing.number };
  const { map, version } = await workOutPageMap(versionId);
  const written = await prisma.$transaction(async (tx) => {
    const file = await lockFileRow(tx, version.fileId);
    if (!file) throw new ApiError("not_found", "File not found.");
    if (file.deleted) throw new ApiError("conflict", "This file is deleted, and nothing is stored about its versions until it is restored.");
    return writePageMapIfNone(tx, versionId, map, by);
  }, MAP_WRITE_TIMEOUTS);
  return { ...written, fileId: version.fileId, number: version.number };
}

/**
 * Answers one run of a version's map: accepted, which writes its proposed
 * sheets into the map, or declined. **Written with the file row locked, onto
 * the map as it then reads**: the map is one value, so two managers
 * answering two runs would otherwise each write the whole of it, and one
 * answer would be lost.
 */
export async function storeRunAnswer(versionId: string, runIndex: number, accepted: boolean, by: { userId: string }): Promise<{ map: PageMap; fileId: string; number: number }> {
  const version = await prisma.fileVersion.findUnique({ where: { id: versionId }, select: { fileId: true, number: true } });
  if (!version) throw new ApiError("not_found", "That version doesn't exist.");
  const map = await prisma.$transaction(async (tx) => {
    const file = await lockFileRow(tx, version.fileId);
    if (!file) throw new ApiError("not_found", "File not found.");
    if (file.deleted) throw new ApiError("conflict", "This file is deleted, and nothing is stored about its versions until it is restored.");
    const row = await tx.fileVersion.findUnique({ where: { id: versionId }, select: { pageMap: true } });
    const standing = parsePageMap(row?.pageMap);
    if (!standing) throw new ApiError("conflict", `Version ${version.number} has no page map to answer a question of.`);
    const answer = answerRun(standing, runIndex, accepted, { userId: by.userId, at: new Date() });
    if ("refused" in answer) throw new ApiError("conflict", answer.refused);
    await tx.fileVersion.update({ where: { id: versionId }, data: { pageMap: pageMapColumn(answer.map) } });
    return answer.map;
  }, MAP_WRITE_TIMEOUTS);
  return { map, fileId: version.fileId, number: version.number };
}
