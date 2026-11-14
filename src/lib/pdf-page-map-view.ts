import { displayNameOf } from "@/lib/display-name";
import { fileVersionState, type FileVersionState } from "@/lib/file-version";
import { usablePageLabels } from "@/lib/pdf-page-labels";
import { REMOVED, pageMapNumbers, parsePageMap, type PageMapNumbers } from "@/lib/pdf-page-map";
import { sheetTextsOf } from "@/lib/pdf-page-map-build";
import { prisma } from "@/lib/prisma";

// docs/PDF.md §13, "Matching the pages" — a version's page map as its own
// page shows it (`/pdf/<slug>/v/<n>/map`): the pairing in ranges, the sheets
// that were removed and the ones left unmapped, and each run of sheets with
// what the page needs to ask its question. Only this page and a candidate's
// numbers say whether a sheet without a counterpart is removed or unmapped.
//
// No gate: the page asks `canUserManageFile` first. Server-only.

/** How much of a sheet's text a row of a `place` run shows. */
const EXCERPT = 220;

/** One sheet of a run: the sheet of the base, the one proposed for it, and what the question is put with. */
export type MapRunRow = {
  /** 1-based. */
  baseSheet: number;
  proposed: number;
  /** For a `labels` run: the sheet the labels give, 1-based, or null where they give none. */
  byLabel: number | null;
  /** The two sheets' own labels, "" for none. */
  baseLabel: string;
  proposedLabel: string;
  /** For a `place` run: whether a label agrees with the place, and how each sheet's text begins. */
  labelAgrees: boolean;
  baseText: string | null;
  proposedText: string | null;
};

export type MapRunView = {
  index: number;
  kind: "labels" | "place";
  state: "open" | "accepted" | "declined";
  answeredBy: string | null;
  answeredAt: string | null;
  rows: MapRunRow[];
};

export type PageMapView = {
  versionId: string;
  number: number;
  state: FileVersionState;
  /** The version it was uploaded over; null for a first version, which has no map to have. */
  baseNumber: number | null;
  map: {
    numbers: PageMapNumbers;
    storedBy: string | null;
    storedAt: string | null;
    /** Whether a bulk carry stored it, on its way. */
    byCarry: boolean;
    /** The pairing, as runs of consecutive sheets: `[first, last]` of the base and of the version, 1-based. */
    paired: { from: [number, number]; to: [number, number] }[];
    removed: [number, number][];
    unmapped: [number, number][];
    runs: MapRunView[];
  } | null;
};

/** Consecutive numbers as `[first, last]` ranges. */
function ranges(sheets: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const sheet of sheets) {
    const open = out[out.length - 1];
    if (open && open[1] + 1 === sheet) open[1] = sheet;
    else out.push([sheet, sheet]);
  }
  return out;
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
      file: { select: { currentVersionId: true } },
    },
  });
  if (!version) return null;
  const head = {
    versionId: version.id,
    number: version.number,
    state: fileVersionState(version, version.file.currentVersionId),
    baseNumber: version.baseVersion?.number ?? null,
  };
  const map = parsePageMap(version.pageMap);
  if (!map || !version.baseVersion) return { ...head, map: null };

  const paired: { from: [number, number]; to: [number, number] }[] = [];
  map.sheets.forEach((to, from) => {
    if (to < 0) return;
    const open = paired[paired.length - 1];
    if (open && open.from[1] === from && open.to[1] === to) {
      open.from[1] = from + 1;
      open.to[1] = to + 1;
    } else paired.push({ from: [from + 1, from + 1], to: [to + 1, to + 1] });
  });
  const without = (kind: "removed" | "unmapped") => ranges(map.sheets.flatMap((to, from) => (to < 0 && (to === REMOVED) === (kind === "removed") ? [from + 1] : [])));

  const baseLabels = ownLabels(version.baseVersion.pageLabels);
  const versionLabels = ownLabels(version.pageLabels);
  const labelled =
    usablePageLabels(baseLabels, version.baseVersion.pageCount ?? 0) !== null && usablePageLabels(versionLabels, version.pageCount ?? 0) !== null;
  // Only a `place` run shows text: each sheet's beside the one proposed for it.
  const placed = map.runs.filter((run) => run.kind === "place");
  const [baseTexts, versionTexts] = await Promise.all([
    sheetTextsOf(
      version.baseVersion.id,
      placed.flatMap((run) => run.proposed.map((_, k) => run.start + k)),
    ),
    sheetTextsOf(
      version.id,
      placed.flatMap((run) => run.proposed),
    ),
  ]);
  const answerers = await prisma.user.findMany({
    where: { id: { in: map.runs.flatMap((run) => (run.answer?.byUserId ? [run.answer.byUserId] : [])) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(answerers.map((user) => [user.id, displayNameOf(user)]));
  const excerpt = (text: string | undefined) => (text === undefined ? null : text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text);

  const runs: MapRunView[] = map.runs.map((run, index) => ({
    index,
    kind: run.kind,
    state: run.answer === null ? "open" : run.answer.accepted ? "accepted" : "declined",
    answeredBy: run.answer?.byUserId ? (nameOf.get(run.answer.byUserId) ?? null) : null,
    answeredAt: run.answer?.at ?? null,
    rows: run.proposed.map((proposed, k): MapRunRow => {
      const base = run.start + k;
      const baseLabel = baseLabels[base] ?? "";
      const proposedLabel = versionLabels[proposed] ?? "";
      return {
        baseSheet: base + 1,
        proposed: proposed + 1,
        byLabel: run.byLabel?.[k] != null ? run.byLabel[k]! + 1 : null,
        baseLabel,
        proposedLabel,
        labelAgrees: labelled && baseLabel.trim() !== "" && baseLabel.trim().toLowerCase() === proposedLabel.trim().toLowerCase(),
        baseText: run.kind === "place" ? excerpt(baseTexts.get(base)) : null,
        proposedText: run.kind === "place" ? excerpt(versionTexts.get(proposed)) : null,
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
      paired,
      removed: without("removed"),
      unmapped: without("unmapped"),
      runs,
    },
  };
}
