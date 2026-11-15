import { displayNameOf } from "@/lib/display-name";
import { fileVersionState, type FileVersionState } from "@/lib/file-version";
import { skeletonOf } from "@/lib/pdf-fragment";
import { usablePageLabels } from "@/lib/pdf-page-labels";
import { carrySheet, pageMapNumbers, parsePageMap, type MapVersion, type PageMap, type PageMapNumbers, type PageMapRun } from "@/lib/pdf-page-map";
import { sheetTextsOf, sheetsWithTextOf } from "@/lib/pdf-page-map-build";
import { pageMapRows, pagesOf, rowSheetsOn, type MapRow, type MapSide } from "@/lib/pdf-page-map-rows";
import { hasRunsToCompare } from "@/lib/pdf-sheet-alike";
import { prisma } from "@/lib/prisma";

// docs/PDF.md §14, "A version's page map, sheet by sheet" — a version's page
// map as its page draws it: every sheet of the base in rows (stretches, runs
// and added sheets, `pageMapRows`), and each run of sheets with what its card
// needs to put its question in words. Only the map's page and a candidate's
// numbers say whether a sheet without a counterpart is removed or unmapped.
//
// No gate: the page asks `canUserManageFile` first. Server-only.

/** How much of a sheet's text a question's card shows. */
const EXCERPT = 220;

/**
 * What a question's card says under a proposed sheet, read from the run's
 * `byLabel` for it and from which sheets have text:
 *
 * - `refused`: its label gave it another sheet, and the words of the two
 *   disagree (rule 2);
 * - `no-text`: its label gave it another sheet, and it or that sheet has no
 *   text to compare, so it went with the sheets around it;
 * - `label-other`: its label gave it another sheet, and which sheets have
 *   text isn't known (an abandoned version, whose text is gone);
 * - `counted`: the labels gave it nothing, and it is placed by counting from
 *   the sheets around it;
 * - `agrees` / `differs`: the proposed sheet's page number agrees with its
 *   own, or doesn't. A `place` run's sheets say one of these where both
 *   versions have usable labels, and nothing otherwise.
 */
export type RunSheetLine = "refused" | "no-text" | "label-other" | "counted" | "agrees" | "differs" | null;

/** One sheet of a run: the sheet of the base, the one proposed for it, and for a `labels` run the one its label gives. */
export type MapRunSheet = {
  /** 1-based. */
  baseSheet: number;
  proposed: number;
  byLabel: number | null;
  /** Each sheet's own label, "" for none. */
  baseLabel: string;
  proposedLabel: string;
  byLabelLabel: string;
  /** How each sheet's text begins, "" for none, and null where the version's text isn't known. */
  baseText: string | null;
  proposedText: string | null;
  byLabelText: string | null;
  line: RunSheetLine;
};

export type MapRunView = {
  index: number;
  kind: "labels" | "place";
  state: "open" | "accepted" | "declined";
  answeredBy: string | null;
  answeredAt: string | null;
  /**
   * For a run paired by an answer: how many notes and link parts a carry
   * moved through its pairs, which un-pairing it leaves where they are. Null
   * for any other run.
   */
  carried: number | null;
  sheets: MapRunSheet[];
};

export type PageMapView = {
  versionId: string;
  number: number;
  state: FileVersionState;
  /** The version it was uploaded over; null for a first version, which has no map to have. */
  baseNumber: number | null;
  baseVersionId: string | null;
  /** The file's latest version, where a carry's notes go. */
  latestNumber: number | null;
  map: {
    numbers: PageMapNumbers;
    storedBy: string | null;
    storedAt: string | null;
    /** Whether a bulk carry stored it, on its way. */
    byCarry: boolean;
    rows: MapRow[];
    /**
     * The printed pages of each row's sheets on each side, beside the row at
     * the same index ("p. 2", "pp. xiii–xxix"; `pagesOf`): what says an added
     * sheet is a page the base lacks. Null on a side whose labels aren't usable,
     * read for each version on its own, and on one the row has no sheet on.
     */
    rowPages: { base: string | null; version: string | null }[];
    runs: MapRunView[];
    /** Whether both versions have usable labels, so that a row can say where page numbers agree. */
    labelled: boolean;
    /** Whether which sheets have text is known: not for an abandoned version, whose text is gone. */
    textKnown: boolean;
  } | null;
};

/**
 * For each accepted run of a version's map, by its index: the notes and link
 * parts a bulk carry moved through its pairs. A move went through them where
 * it reached this version or one after it, from a version before it, and its
 * sheet, carried from the version it left to this map's base, is one of the
 * run's (`carrySheet`, through the maps as they now stand, the run's pairs
 * among them). An anchor counts once, however many moves it made. A move one
 * person made of one note is that person's judgment, and isn't counted.
 */
async function carriedThroughRuns(fileId: string, versionId: string, baseNumber: number, map: PageMap): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  const runs = map.runs.flatMap((run, index) => (run.answer?.accepted ? [{ index, first: run.start, last: run.start + run.proposed.length - 1 }] : []));
  if (runs.length === 0) return counts;
  const versions = await prisma.fileVersion.findMany({ where: { fileId }, select: { id: true, number: true, baseVersionId: true, pageMap: true } });
  const numberOf = new Map(versions.map((version) => [version.id, version.number]));
  const carrying: MapVersion[] = versions.map((version) => ({
    number: version.number,
    base: version.baseVersionId === null ? null : (numberOf.get(version.baseVersionId) ?? null),
    map: version.id === versionId ? map.sheets : (parsePageMap(version.pageMap)?.sheets ?? null),
  }));
  // This version and every version uploaded over it, at any remove.
  const below = new Set([versionId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const version of versions) {
      if (version.baseVersionId !== null && below.has(version.baseVersionId) && !below.has(version.id)) {
        below.add(version.id);
        grew = true;
      }
    }
  }
  const moves = await prisma.fileAnchorMove.findMany({
    where: { carryId: { not: null }, toVersionId: { in: [...below] }, fromVersionId: { in: versions.filter((version) => !below.has(version.id)).map((version) => version.id) } },
    select: { annotationId: true, anchoredLinkAnchorId: true, fromVersionId: true, fromTarget: true },
  });
  const anchors = new Map<number, Set<string>>();
  for (const move of moves) {
    const pageIndex = (move.fromTarget as { pageIndex?: unknown } | null)?.pageIndex;
    const from = numberOf.get(move.fromVersionId);
    if (!Number.isInteger(pageIndex) || from === undefined) continue;
    const carried = carrySheet(pageIndex as number, from, baseNumber, carrying);
    if (carried.kind !== "carried") continue;
    const run = runs.find((candidate) => candidate.first <= carried.sheet && carried.sheet <= candidate.last);
    if (!run) continue;
    const held = anchors.get(run.index) ?? new Set<string>();
    held.add(move.annotationId ?? `part:${move.anchoredLinkAnchorId}`);
    anchors.set(run.index, held);
  }
  for (const run of runs) counts.set(run.index, anchors.get(run.index)?.size ?? 0);
  return counts;
}

const ownLabels = (stored: unknown): string[] => (Array.isArray(stored) ? stored.map((label) => (typeof label === "string" ? label : "")) : []);

export async function pageMapViewFor(fileId: string, versionId: string): Promise<PageMapView | null> {
  const version = await prisma.fileVersion.findFirst({
    where: { id: versionId, fileId },
    select: {
      id: true,
      number: true,
      pageCount: true,
      pageLabels: true,
      promotedAt: true,
      abandonedAt: true,
      pageMap: true,
      pageMapStoredAt: true,
      pageMapCarryId: true,
      pageMapStoredBy: { select: { name: true } },
      baseVersion: { select: { id: true, number: true, pageCount: true, pageLabels: true } },
      file: { select: { currentVersionId: true, currentVersion: { select: { number: true } } } },
    },
  });
  if (!version) return null;
  const head = {
    versionId: version.id,
    number: version.number,
    state: fileVersionState(version, version.file.currentVersionId),
    baseNumber: version.baseVersion?.number ?? null,
    baseVersionId: version.baseVersion?.id ?? null,
    latestNumber: version.file.currentVersion?.number ?? null,
  };
  const map = parsePageMap(version.pageMap);
  if (!map || !version.baseVersion) return { ...head, map: null };

  const baseLabels = ownLabels(version.baseVersion.pageLabels);
  const versionLabels = ownLabels(version.pageLabels);
  // Read as rule 1 reads them: each version's own labels, where both sets are usable.
  const labelled =
    usablePageLabels(baseLabels, version.baseVersion.pageCount ?? 0) !== null && usablePageLabels(versionLabels, version.pageCount ?? 0) !== null;
  // Abandoning deletes a version's page text, and may leave its map: an
  // abandoned version's list says nothing of text, and its cards show no words.
  const textKnown = version.abandonedAt === null;

  const runSheets = (pick: (run: PageMapRun, k: number) => number | null | undefined) =>
    map.runs.flatMap((run) => run.proposed.flatMap((_, k) => pick(run, k) ?? []));
  const [baseWithText, versionWithText, baseTexts, versionTexts] = textKnown
    ? await Promise.all([
        sheetsWithTextOf(version.baseVersion.id),
        sheetsWithTextOf(version.id),
        sheetTextsOf(
          version.baseVersion.id,
          runSheets((run, k) => run.start + k),
        ),
        sheetTextsOf(version.id, [...new Set([...runSheets((run, k) => run.proposed[k]), ...runSheets((run, k) => run.byLabel?.[k])])]),
      ])
    : [null, null, null, null];

  const side = (labels: string[], withText: Set<number> | null): MapSide => ({ labels: labelled ? labels : null, withText });
  const rows = pageMapRows(map, side(baseLabels, baseWithText), side(versionLabels, versionWithText));
  // Each version's page numbers on their own: a row names its pages where its version has usable labels, whatever the other's are.
  const basePages = usablePageLabels(baseLabels, version.baseVersion.pageCount ?? 0) !== null ? baseLabels : null;
  const versionPages = usablePageLabels(versionLabels, version.pageCount ?? 0) !== null ? versionLabels : null;
  const rowPages = rows.map((row) => ({ base: pagesOf(basePages, rowSheetsOn(row, "base")), version: pagesOf(versionPages, rowSheetsOn(row, "version")) }));

  const answerers = await prisma.user.findMany({
    where: { id: { in: map.runs.flatMap((run) => (run.answer?.byUserId ? [run.answer.byUserId] : [])) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(answerers.map((user) => [user.id, displayNameOf(user)]));
  const carried = await carriedThroughRuns(fileId, version.id, version.baseVersion.number, map);
  const excerpt = (texts: Map<number, string> | null, sheet: number | null) => {
    if (texts === null || sheet === null) return null;
    const text = texts.get(sheet) ?? "";
    return text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
  };
  // The matcher's own test of whether a sheet has text to compare, which is what rule 2 asked of the two.
  const comparable = (texts: Map<number, string> | null, sheet: number) => texts !== null && hasRunsToCompare(skeletonOf(texts.get(sheet) ?? "").text);
  const sameLabel = (a: string, b: string) => a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

  const runs: MapRunView[] = map.runs.map((run, index) => ({
    index,
    kind: run.kind,
    state: run.answer === null ? "open" : run.answer.accepted ? "accepted" : "declined",
    answeredBy: run.answer?.byUserId ? (nameOf.get(run.answer.byUserId) ?? null) : null,
    answeredAt: run.answer?.at ?? null,
    carried: carried.get(index) ?? null,
    sheets: run.proposed.map((proposed, k): MapRunSheet => {
      const base = run.start + k;
      const byLabel = run.kind === "labels" ? (run.byLabel?.[k] ?? null) : null;
      const baseLabel = baseLabels[base] ?? "";
      const proposedLabel = versionLabels[proposed] ?? "";
      let line: RunSheetLine = null;
      if (run.kind === "place") {
        // Two sheets without a page number neither agree nor differ.
        if (labelled) line = sameLabel(baseLabel, proposedLabel) ? "agrees" : baseLabel.trim() !== "" || proposedLabel.trim() !== "" ? "differs" : null;
      } else if (byLabel === null) line = "counted";
      else if (byLabel === proposed) line = "agrees";
      else if (!textKnown) line = "label-other";
      else line = comparable(baseTexts, base) && comparable(versionTexts, byLabel) ? "refused" : "no-text";
      return {
        baseSheet: base + 1,
        proposed: proposed + 1,
        byLabel: byLabel === null ? null : byLabel + 1,
        baseLabel,
        proposedLabel,
        byLabelLabel: byLabel === null ? "" : (versionLabels[byLabel] ?? ""),
        baseText: excerpt(baseTexts, base),
        proposedText: excerpt(versionTexts, proposed),
        byLabelText: excerpt(versionTexts, byLabel),
        line,
      };
    }),
  }));

  return {
    ...head,
    map: {
      numbers: pageMapNumbers(map),
      storedBy: version.pageMapStoredBy ? displayNameOf(version.pageMapStoredBy) : null,
      storedAt: version.pageMapStoredAt?.toISOString() ?? null,
      byCarry: version.pageMapCarryId !== null,
      rows,
      rowPages,
      runs,
      labelled,
      textKnown,
    },
  };
}
