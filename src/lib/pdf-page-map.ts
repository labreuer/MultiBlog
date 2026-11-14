// docs/PDF.md §13, "Matching the pages" — a page map, as it is stored and
// read. A map is between a version and its base: it gives each sheet of the
// base a sheet of the version, or none. One sheet pairs with one sheet. It is
// one JSON value on the version's row (`file_version.page_map`), read in both
// directions.
//
// This module is the map's shape, its readers, the carrying of a sheet from
// one version to another through the maps between them, and the answer to a
// run of sheets. The rules that pair the sheets are
// `src/lib/pdf-page-map-pairing.ts`, and what reads a version's text and
// stores a map is `src/lib/pdf-page-map-build.ts`, a server module.
//
// Pure and browser-safe: the viewer carries a link's sheet with it, as the
// cited-page route, MCP and the checks do, so none lands a link on a sheet
// another would not.

/** A sheet of the base that the version no longer has: nothing stands in its place. */
export const REMOVED = -1;
/** A sheet of the base no rule could place, or one with a proposal nobody has accepted. */
export const UNMAPPED = -2;

/**
 * A question a map asks of whoever may manage the file, about a run of
 * consecutive sheets of the base, never about one sheet:
 *
 * - `labels`: whether to pair the sheets as the text does, where the labels
 *   pair them otherwise;
 * - `place`: whether to pair the sheets by their place, where their text is
 *   too unlike to say.
 *
 * Until it is accepted its sheets are unmapped. Declining leaves them so and
 * takes the question off the list of open ones; a declined run may still be
 * accepted later. An accepted run stays.
 */
export type PageMapRun = {
  kind: "labels" | "place";
  /** The run's first sheet of the base, 0-based. Its sheets are consecutive. */
  start: number;
  /** The sheet of the version proposed for each sheet of the run, 0-based. */
  proposed: number[];
  /** For a `labels` run: the sheet the labels give each sheet of the run, or null where they give none. */
  byLabel?: (number | null)[];
  /** Null while nobody has answered. */
  answer: { accepted: boolean; byUserId: string | null; at: string } | null;
};

export type PageMap = {
  /** How many sheets the base has, and the version. */
  from: number;
  to: number;
  /** For each sheet of the base: the 0-based sheet of the version it is, `REMOVED` or `UNMAPPED`. */
  sheets: number[];
  runs: PageMapRun[];
  /**
   * The sheets of each side that have no text and draw nothing, 0-based. A
   * blank sheet added is a known insertion and one removed a known deletion,
   * which is what says a sheet beside one was removed and not merely
   * unmapped (`classifyUnpaired`).
   */
  blank: { from: number[]; to: number[] };
};

function isIndex(value: unknown, below: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < below;
}

/**
 * A stored map, or null for a value that isn't one. Checked for shape and for
 * bounds, so no reader indexes past a version's sheets; what a map must also
 * hold to be right (no two sheets with one counterpart, an accepted run
 * written in) is `pageMapFaults`, which the integrity check reports.
 */
export function parsePageMap(value: unknown): PageMap | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { from, to } = raw;
  if (!Number.isInteger(from) || !Number.isInteger(to) || (from as number) < 0 || (to as number) < 0) return null;
  const fromCount = from as number;
  const toCount = to as number;
  if (!Array.isArray(raw.sheets) || raw.sheets.length !== fromCount) return null;
  const sheets: number[] = [];
  for (const sheet of raw.sheets) {
    if (sheet !== REMOVED && sheet !== UNMAPPED && !isIndex(sheet, toCount)) return null;
    sheets.push(sheet as number);
  }
  if (!Array.isArray(raw.runs)) return null;
  const runs: PageMapRun[] = [];
  for (const candidate of raw.runs) {
    if (!candidate || typeof candidate !== "object") return null;
    const run = candidate as Record<string, unknown>;
    if (run.kind !== "labels" && run.kind !== "place") return null;
    if (!Array.isArray(run.proposed) || run.proposed.length === 0) return null;
    if (!isIndex(run.start, fromCount) || run.start + run.proposed.length > fromCount) return null;
    if (!run.proposed.every((sheet) => isIndex(sheet, toCount))) return null;
    let byLabel: (number | null)[] | undefined;
    if (run.byLabel !== undefined) {
      if (!Array.isArray(run.byLabel) || run.byLabel.length !== run.proposed.length) return null;
      if (!run.byLabel.every((sheet) => sheet === null || isIndex(sheet, toCount))) return null;
      byLabel = run.byLabel as (number | null)[];
    }
    let answer: PageMapRun["answer"] = null;
    if (run.answer !== null && run.answer !== undefined) {
      const given = run.answer as Record<string, unknown>;
      if (typeof given.accepted !== "boolean" || typeof given.at !== "string") return null;
      if (given.byUserId !== null && typeof given.byUserId !== "string") return null;
      answer = { accepted: given.accepted, byUserId: given.byUserId, at: given.at };
    }
    runs.push({ kind: run.kind, start: run.start, proposed: run.proposed as number[], ...(byLabel ? { byLabel } : {}), answer });
  }
  const blank = raw.blank as Record<string, unknown> | undefined;
  if (!blank || typeof blank !== "object" || !Array.isArray(blank.from) || !Array.isArray(blank.to)) return null;
  if (!blank.from.every((sheet) => isIndex(sheet, fromCount)) || !blank.to.every((sheet) => isIndex(sheet, toCount))) return null;
  return { from: fromCount, to: toCount, sheets, runs, blank: { from: blank.from as number[], to: blank.to as number[] } };
}

/** Just the pairing, which is all a reader carrying a sheet needs: what the viewer is sent of each version's map. */
export type SheetPairs = readonly number[];

/** The sheet of the version that a sheet of the base is, or null where it has none (removed or unmapped: a reader is not told which). Both 0-based. */
export function counterpartOf(pairs: SheetPairs, baseSheet: number): number | null {
  const to = pairs[baseSheet];
  return to !== undefined && to >= 0 ? to : null;
}

/** The sheet of the base that a sheet of the version is, or null where none maps to it. Both 0-based. */
export function counterpartBack(pairs: SheetPairs, versionSheet: number): number | null {
  const from = pairs.indexOf(versionSheet);
  return versionSheet >= 0 && from >= 0 ? from : null;
}

/**
 * A version as carrying reads it: its number, its base's number (null for a
 * first version), and the pairing of its map from that base (null where it
 * has none).
 */
export type MapVersion = { number: number; base?: number | null; map?: SheetPairs | null };

type Step = { pairs: SheetPairs; forward: boolean };

/**
 * The maps between two versions, in the order a sheet goes through them, or
 * null where one on the way is missing.
 *
 * The promoted versions are a line and an abandoned one hangs off it at its
 * base, so the way from one version to another is back to the nearest
 * version both descend from, and forward from there. Each step back reads a
 * version's map from its counterpart to its base, and each step forward the
 * other way round. So a link stamped with an abandoned version is carried
 * back off it and on to the version shown.
 */
function mapPath(from: number, to: number, versions: readonly MapVersion[]): Step[] | null {
  if (from === to) return [];
  const byNumber = new Map(versions.map((version) => [version.number, version]));
  // The version shown and every version it descends from, nearest first.
  const down: MapVersion[] = [];
  for (let at = byNumber.get(to); at; at = at.base == null ? undefined : byNumber.get(at.base)) {
    if (down.includes(at)) return null;
    down.push(at);
  }
  if (down.length === 0) return null;
  const steps: Step[] = [];
  const seen = new Set<number>();
  let at = byNumber.get(from);
  while (at && !down.includes(at)) {
    if (seen.has(at.number) || !at.map) return null;
    seen.add(at.number);
    steps.push({ pairs: at.map, forward: false });
    at = at.base == null ? undefined : byNumber.get(at.base);
  }
  if (!at) return null;
  for (let index = down.indexOf(at) - 1; index >= 0; index--) {
    const map = down[index].map;
    if (!map) return null;
    steps.push({ pairs: map, forward: true });
  }
  return steps;
}

/** Whether page maps join two versions without a break, so that a link or a note on one can be carried to the other. */
export function mapsJoin(from: number, to: number, versions: readonly MapVersion[]): boolean {
  return mapPath(from, to, versions) !== null;
}

export type CarriedSheet =
  /** Every map on the way gave the sheet a counterpart: `sheet` is on the version carried to. 0-based. */
  | { kind: "carried"; sheet: number }
  /** The maps join the two versions, and one of them leaves the sheet removed or unmapped, or the version carried to lacks it. */
  | { kind: "no-counterpart" }
  /** A map on the way is missing: a revised text stands between the two versions. */
  | { kind: "no-map" };

/**
 * A sheet of one version carried to another through the page map of each
 * version between them, in either direction (docs/PDF.md §13, "Links into
 * the file"). **The one function that carries a sheet**, for the viewer, the
 * cited-page route, MCP, the checks and a note's mapped sheet. Sheets are
 * 0-based.
 */
export function carrySheet(sheet: number, from: number, to: number, versions: readonly MapVersion[]): CarriedSheet {
  const path = mapPath(from, to, versions);
  if (!path) return { kind: "no-map" };
  let at: number | null = sheet;
  for (const step of path) {
    at = step.forward ? counterpartOf(step.pairs, at) : counterpartBack(step.pairs, at);
    if (at === null) return { kind: "no-counterpart" };
  }
  return { kind: "carried", sheet: at };
}

/**
 * Whether each sheet without a counterpart is removed or unmapped, worked
 * out anew from the pairing as it stands, so it stays right after a run is
 * accepted. Returns the map with those sheets marked.
 *
 * - A sheet in a run nobody has accepted is **unmapped**.
 * - A blank sheet with no counterpart is **removed** wherever it stood.
 * - Any other is **removed** when nothing stands in its place: the nearest
 *   paired sheets before and after it have counterparts with nothing between
 *   them in the version but blank sheets, which were added. At either end of
 *   the base, the paired sheet on its one side has its counterpart at that
 *   end of the version.
 * - Every other sheet is **unmapped**: sheets of the version stand where it
 *   stood, and none of them is known to be it.
 */
export function classifyUnpaired(map: PageMap): PageMap {
  const sheets = [...map.sheets];
  const pending = new Set<number>();
  for (const run of map.runs) {
    if (run.answer?.accepted) continue;
    for (let k = 0; k < run.proposed.length; k++) pending.add(run.start + k);
  }
  const blankFrom = new Set(map.blank.from);
  const blankTo = new Set(map.blank.to);
  const taken = new Set(sheets.filter((sheet) => sheet >= 0));
  // Whether nothing but an added blank sheet stands strictly between two sheets of the version.
  const nothingBetween = (low: number, high: number): boolean => {
    if (low >= high) return false;
    for (let sheet = low + 1; sheet < high; sheet++) if (!blankTo.has(sheet) || taken.has(sheet)) return false;
    return true;
  };
  let before = -1;
  for (let index = 0; index < sheets.length; index++) {
    if (sheets[index] >= 0) {
      before = sheets[index];
      continue;
    }
    if (pending.has(index)) {
      sheets[index] = UNMAPPED;
      continue;
    }
    if (blankFrom.has(index)) {
      sheets[index] = REMOVED;
      continue;
    }
    let after = map.to;
    for (let next = index + 1; next < sheets.length; next++) {
      if (sheets[next] >= 0) {
        after = sheets[next];
        break;
      }
    }
    sheets[index] = nothingBetween(before, after) ? REMOVED : UNMAPPED;
  }
  return { ...map, sheets };
}

/** A map in numbers, as a candidate's page and the version list show it. */
export type PageMapNumbers = { paired: number; removed: number; unmapped: number; openRuns: number };

export function pageMapNumbers(map: PageMap): PageMapNumbers {
  let paired = 0;
  let removed = 0;
  let unmapped = 0;
  for (const sheet of map.sheets) {
    if (sheet >= 0) paired++;
    else if (sheet === REMOVED) removed++;
    else unmapped++;
  }
  return { paired, removed, unmapped, openRuns: map.runs.filter((run) => run.answer === null).length };
}

/**
 * A map with one run answered, or why it can't be.
 *
 * **Accepting writes the proposed sheets into the map, and stays**: an
 * accepted run is not declined afterwards, since notes and links have gone
 * through it. Declining leaves the run's sheets unmapped; a declined run may
 * still be accepted later. Whoever stores the result does so under the file
 * row's lock, onto the map as it then reads, since the map is one value and
 * two answers would otherwise each write the whole of it.
 */
export function answerRun(
  map: PageMap,
  runIndex: number,
  accepted: boolean,
  by: { userId: string; at: Date },
): { map: PageMap } | { refused: string } {
  const run = map.runs[runIndex];
  if (!run) return { refused: "That question isn't one this page map asks." };
  if (run.answer?.accepted) {
    return { refused: accepted ? "Those sheets are already paired as proposed." : "Those sheets were paired as proposed, which can't be taken back: notes and links have gone through them." };
  }
  const answer = { accepted, byUserId: by.userId, at: by.at.toISOString() };
  const runs = map.runs.map((other, index) => (index === runIndex ? { ...other, answer } : other));
  if (!accepted) return { map: classifyUnpaired({ ...map, runs }) };
  const sheets = [...map.sheets];
  const taken = new Set(sheets.filter((sheet) => sheet >= 0));
  for (let k = 0; k < run.proposed.length; k++) {
    if (taken.has(run.proposed[k])) return { refused: "A sheet proposed for that run is already another sheet's counterpart." };
    taken.add(run.proposed[k]);
    sheets[run.start + k] = run.proposed[k];
  }
  return { map: classifyUnpaired({ ...map, sheets, runs }) };
}

/**
 * What is wrong with a stored map, for the integrity check
 * (`scripts/integrity/check-file-versions.ts`): empty for a sound one. It
 * pairs sheets that exist, and no two with one counterpart; an accepted run
 * is written in, and a run that isn't accepted leaves its sheets unmapped.
 */
export function pageMapFaults(map: PageMap, sheetCounts: { base: number | null; version: number | null }): string[] {
  const faults: string[] = [];
  if (sheetCounts.base !== null && map.from !== sheetCounts.base) faults.push(`it is of ${map.from} sheets, and its base has ${sheetCounts.base}`);
  if (sheetCounts.version !== null && map.to !== sheetCounts.version) faults.push(`it is onto ${map.to} sheets, and its version has ${sheetCounts.version}`);
  const seen = new Map<number, number>();
  map.sheets.forEach((to, from) => {
    if (to < 0) return;
    const other = seen.get(to);
    if (other !== undefined) faults.push(`sheets ${other + 1} and ${from + 1} both map to sheet ${to + 1}`);
    else seen.set(to, from);
  });
  map.runs.forEach((run, index) => {
    for (let k = 0; k < run.proposed.length; k++) {
      const stored = map.sheets[run.start + k];
      if (run.answer?.accepted ? stored !== run.proposed[k] : stored !== UNMAPPED) {
        faults.push(
          run.answer?.accepted
            ? `run ${index + 1} was accepted, and sheet ${run.start + k + 1} is not paired as it proposed`
            : `run ${index + 1} is not accepted, and sheet ${run.start + k + 1} is not unmapped`,
        );
        break;
      }
    }
  });
  return faults;
}
