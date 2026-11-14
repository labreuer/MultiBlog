import { readFile } from "node:fs/promises";
import { storagePathFor } from "@/lib/file-storage";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { currentTextVersion, extractSheetsItems, type SheetItems } from "@/lib/pdf-extract";
import { carrySheet, type MapVersion } from "@/lib/pdf-page-map";
import { storedPageText } from "@/lib/pdf-page-text";
import { placeQuads, placeQuote, sheetTextOf, type QuadsFound, type QuoteFound, type SheetGeometry, type SheetText } from "@/lib/pdf-placing";
import { quadsForRange } from "@/lib/pdf-quads";
import { buildQuote } from "@/lib/pdf-quote";
import { normalisePageText } from "@/lib/pdf-text";
import { prisma } from "@/lib/prisma";

// docs/PDF.md §13, "Placing each anchor" — the server half of the placing
// rules: reading what `src/lib/pdf-placing.ts` takes, and measuring the
// target each placement gives on the later version's sheet.
//
// **Each version's document is opened once, and each sheet read once.**
// Opening a document costs far more than reading a sheet of it, and a carry
// places hundreds of notes. So every placement is first decided from stored
// page text alone, which names the sheets that have to be measured, and
// those are then read together: the destination's in one open, and each
// earlier version's (a rectangle's own sheet, for the fit) in one.
//
// **It writes no anchor and locks nothing.** The work takes seconds, so it
// comes before the transaction that writes a move, whose own condition is
// what holds against a note that changed meanwhile (`writeAnchorMoves`,
// src/lib/file-anchor-move.ts). The one thing it may write is the later
// version's page text at the current text version, where that version has
// none yet: every new target names it, and it is extracted as a capture
// extracts it (`storedPageText`).
//
// Server-only (Prisma, `node:fs`).

/** A version of a file as an anchor is placed from it or onto it. */
export type PlacingVersion = { id: string; number: number; sha256: string; pageCount: number | null };

/** An anchor where it is now: its version and the target it has there. */
export type AnchorAt = { versionId: string; target: PdfTarget };

/** Why an anchor has no place on the later version. */
export type NoPlace =
  /** A page map is missing between the two versions, and its words are not found once in the later one. */
  | "not-found"
  /** Its words are found more than once. */
  | "several"
  /** A target with no words whose sheet has no counterpart. */
  | "no-sheet"
  /** A target with no words whose sheet's ink can't be fitted to its counterpart's. */
  | "no-fit"
  /** A target with no words on a sheet without text, whose counterpart has another page box. */
  | "other-box"
  /** The later sheet can't be measured: its text items don't reproduce its stored page text, or the range covers no glyph. */
  | "unmeasurable";

export type AnchorPlacement =
  | {
      kind: "placed" | "proposal";
      /** The target on the later version, measured there, at the current text version. */
      target: PdfTarget;
      quotedText: string;
      how: QuoteFound | QuadsFound;
      /** Where its words were corrected: the share of the quote's letters that changed. */
      changed?: number;
    }
  | { kind: "none"; why: NoPlace };

/** A target with no words to be found by: a rectangle selection, or a text selection whose quote its capture dropped. */
export function isWordless(target: PdfTarget): boolean {
  return target.position === null || target.quote.exact === "";
}

/** A version's stored page text at one text version, for the sheets asked or for all of them (null). */
async function textsAt(fileVersionId: string, textVersion: string, sheets: readonly number[] | null): Promise<Map<number, string>> {
  const rows = await prisma.filePageText.findMany({
    where: { fileVersionId, textVersion, ...(sheets ? { pageIndex: { in: [...sheets] } } : {}) },
    select: { pageIndex: true, text: true },
  });
  return new Map(rows.map((row) => [row.pageIndex, row.text]));
}

/** Some sheets of a version from one open document; empty where its bytes can't be read. */
async function sheetsOf(version: PlacingVersion, sheets: ReadonlySet<number>): Promise<Map<number, SheetItems>> {
  if (sheets.size === 0) return new Map();
  try {
    return (await extractSheetsItems(await readFile(storagePathFor(version.sha256)), [...sheets])).sheets;
  } catch (error) {
    console.error(`[file-anchor-placements] couldn't read the sheets of file version ${version.id}:`, error);
    return new Map();
  }
}

const geometryOf = (sheet: SheetItems): SheetGeometry => ({ box: sheet.box, rotation: sheet.rotation, measured: { ...normalisePageText(sheet.items), items: sheet.items } });

/**
 * Where each of these anchors would go on `destination`, in the order
 * given. `versions` are the file's versions the anchors are on, and `maps`
 * what carries a sheet between two of them (`carrySheet`): the stored page
 * maps, or for a look at what a carry would do, maps worked out and not
 * stored.
 *
 * The new target is measured as MCP measures one (docs/MCP.md §8): quads
 * from `quadsForRange` over the sheet's own text items, checked against the
 * sheet's stored page text first, and the quote sliced from that stored text
 * at the range, as `capturePdfTextAnchor` derives it.
 */
export async function workOutPlacements(
  anchors: readonly AnchorAt[],
  versions: readonly PlacingVersion[],
  destination: PlacingVersion,
  maps: readonly MapVersion[],
): Promise<AnchorPlacement[]> {
  if (anchors.length === 0) return [];
  const byId = new Map(versions.map((version) => [version.id, version]));
  const textVersion = await currentTextVersion();
  // Asked through `storedPageText`, which extracts a version that has no
  // text at the current text version yet: every new target names it.
  const measurable = destination.pageCount !== null && destination.pageCount > 0 && (await storedPageText(destination.id, 0, textVersion)) !== null;
  if (!measurable) return anchors.map(() => ({ kind: "none", why: "unmeasurable" }));
  const laterTexts = await textsAt(destination.id, textVersion, null);
  const pageCount = destination.pageCount ?? 0;

  // The later version's sheets with their skeletons, made on first need: a
  // carry of rectangles alone looks for no words.
  let later: SheetText[] | null = null;
  const laterSheets = () => (later ??= Array.from({ length: pageCount }, (_, index) => sheetTextOf(laterTexts.get(index) ?? "")));

  // Each anchor's own sheet, at the text version its offsets are into.
  const wanted = new Map<string, { versionId: string; textVersion: string; sheets: Set<number> }>();
  for (const { versionId, target } of anchors) {
    if (isWordless(target)) continue;
    const key = `${versionId}\n${target.textVersion}`;
    let group = wanted.get(key);
    if (!group) wanted.set(key, (group = { versionId, textVersion: target.textVersion, sheets: new Set() }));
    group.sheets.add(target.pageIndex);
  }
  const earlierTexts = new Map<string, Map<number, string>>();
  await Promise.all([...wanted].map(async ([key, group]) => earlierTexts.set(key, await textsAt(group.versionId, group.textVersion, [...group.sheets]))));

  // First from text alone: which sheet and range, or which pair of sheets to fit.
  type Decided =
    | { kind: "text"; placed: "placed" | "proposal"; sheet: number; range: { start: number; end: number }; how: QuoteFound; changed?: number }
    | { kind: "quads"; from: { versionId: string; sheet: number }; sheet: number }
    | { kind: "none"; why: NoPlace };
  const laterNeeded = new Set<number>();
  const earlierNeeded = new Map<string, Set<number>>();
  const decided = anchors.map(({ versionId, target }): Decided => {
    const from = byId.get(versionId);
    const carried = from ? carrySheet(target.pageIndex, from.number, destination.number, maps) : { kind: "no-map" as const };
    const mapped = carried.kind === "carried" && carried.sheet < pageCount ? carried.sheet : null;
    if (isWordless(target)) {
      if (mapped === null) return { kind: "none", why: "no-sheet" };
      laterNeeded.add(mapped);
      let sheets = earlierNeeded.get(versionId);
      if (!sheets) earlierNeeded.set(versionId, (sheets = new Set()));
      sheets.add(target.pageIndex);
      return { kind: "quads", from: { versionId, sheet: target.pageIndex }, sheet: mapped };
    }
    const earlierText = earlierTexts.get(`${versionId}\n${target.textVersion}`)?.get(target.pageIndex) ?? null;
    const placement = placeQuote({ quote: target.quote, position: target.position! }, earlierText, laterSheets(), mapped);
    if (placement.kind === "none") return placement;
    laterNeeded.add(placement.sheet);
    return { kind: "text", placed: placement.kind, sheet: placement.sheet, range: placement.range, how: placement.how, changed: placement.changed };
  });

  // Then the sheets those name, each version's document opened once.
  const laterItems = await sheetsOf(destination, laterNeeded);
  const earlierItems = new Map<string, Map<number, SheetItems>>();
  for (const [versionId, sheets] of earlierNeeded) {
    const version = byId.get(versionId);
    earlierItems.set(versionId, version ? await sheetsOf(version, sheets) : new Map());
  }
  // One normalisation and one geometry for each sheet, however many anchors land on it.
  const laterGeometry = new Map<number, SheetGeometry>();
  const laterOn = (sheet: number): SheetGeometry | null => {
    const items = laterItems.get(sheet);
    if (!items) return null;
    let geometry = laterGeometry.get(sheet);
    if (!geometry) laterGeometry.set(sheet, (geometry = geometryOf(items)));
    return geometry;
  };
  const earlierGeometry = new Map<string, SheetGeometry>();
  const earlierOn = (versionId: string, sheet: number): SheetGeometry | null => {
    const items = earlierItems.get(versionId)?.get(sheet);
    if (!items) return null;
    const key = `${versionId}\n${sheet}`;
    let geometry = earlierGeometry.get(key);
    if (!geometry) earlierGeometry.set(key, (geometry = geometryOf(items)));
    return geometry;
  };

  return decided.map((decision, index): AnchorPlacement => {
    if (decision.kind === "none") return decision;
    const on = laterOn(decision.sheet);
    if (!on) return { kind: "none", why: "unmeasurable" };
    if (decision.kind === "quads") {
      const from = earlierOn(decision.from.versionId, decision.from.sheet);
      if (!from) return { kind: "none", why: "unmeasurable" };
      const placement = placeQuads(anchors[index].target.quads, from, on);
      if (placement.kind === "none") return placement;
      return {
        kind: placement.kind,
        // Its offsets were into the earlier version's page text, and the
        // words around it were that version's: neither is true of this sheet.
        target: { pageIndex: decision.sheet, quads: placement.quads, quote: { exact: "", prefix: "", suffix: "" }, position: null, textVersion },
        quotedText: "",
        how: placement.how,
      };
    }
    // The sheet's items must reproduce its stored text, or the offsets the
    // range is in are not offsets into what the items measure.
    const stored = laterTexts.get(decision.sheet);
    if (stored === undefined || on.measured.text !== stored) return { kind: "none", why: "unmeasurable" };
    const quads = quadsForRange(on.measured.items, on.measured.offsets, decision.range.start, decision.range.end);
    if (quads.length === 0) return { kind: "none", why: "unmeasurable" };
    const quote = buildQuote(stored, decision.range, "");
    return {
      kind: decision.placed,
      target: { pageIndex: decision.sheet, quads, quote, position: decision.range, textVersion },
      quotedText: quote.exact,
      how: decision.how,
      ...(decision.changed !== undefined ? { changed: decision.changed } : {}),
    };
  });
}
