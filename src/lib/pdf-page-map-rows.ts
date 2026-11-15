import { REMOVED, type PageMap } from "./pdf-page-map";

// docs/PDF.md §14, "A version's page map, sheet by sheet" — a page map as the
// list of rows its page draws: every sheet of the base, in order, in rows,
// and every sheet of the version in exactly one row.
//
// - A **stretch** is consecutive sheets of the base outside every run, all of
//   one kind: matched to consecutive sheets of the version by one offset,
//   removed, or unmapped.
// - A **run** is one row whole, whatever its answer: its sheets of the base
//   are consecutive, and the sheets it proposes need not be.
// - An **added** stretch is sheets of the version no sheet of the base goes
//   to and no run proposes. It follows the row that holds the version's sheet
//   before its first, and comes first of all where it begins at the version's
//   first sheet: two pairs can cross, so "between the rows it falls between"
//   has no answer for every map.
//
// What a matched row says of its pairs is read from the two versions' labels
// and which of their sheets have text, never from the rule that paired them,
// which the map doesn't keep. Neither fact splits a stretch.
//
// Pure and browser-safe. Sheets in rows are 1-based, as the page shows them.

/** What the rows read of one version besides the map. */
export type MapSide = {
  /** Its own labels, by 0-based sheet, or null where they aren't usable (`usablePageLabels`). */
  labels: readonly string[] | null;
  /** The 0-based sheets that hold a letter or a digit, or null where that isn't known (an abandoned version, whose text is gone). */
  withText: ReadonlySet<number> | null;
};

export type MapRow =
  | {
      kind: "matched";
      base: [number, number];
      version: [number, number];
      /** The version's sheet less the base's: negative where the sheets are earlier in the version. */
      offset: number;
      /** On how many pairs the page numbers agree, or null where either version has no usable labels. */
      labelsAgree: number | null;
      /** The base's sheet of each pair whose page numbers differ (one has a label the other lacks, or the two differ), or null as above. */
      labelsDiffer: number[] | null;
      /** The base's sheet of each pair of which a sheet has no text, or null where neither side's text is known. */
      withoutText: number[] | null;
    }
  | { kind: "removed"; base: [number, number] }
  | { kind: "unmapped"; base: [number, number] }
  | {
      kind: "run";
      /** Its index in the map's runs. */
      run: number;
      base: [number, number];
      /** The sheet of the version proposed for each sheet of the run, in the run's order. */
      version: number[];
    }
  | { kind: "added"; version: [number, number] };

/** Page numbers read as rule 1 reads them: trimmed, in any case, and an empty one is none. */
const labelKey = (labels: readonly string[], sheet: number) => (labels[sheet] ?? "").trim().toLowerCase();

/** The map's rows, in the base's order with each added stretch after the row it follows. */
export function pageMapRows(map: PageMap, base: MapSide, version: MapSide): MapRow[] {
  const runAt = new Map<number, number>();
  map.runs.forEach((run, index) => {
    for (let k = 0; k < run.proposed.length; k++) runAt.set(run.start + k, index);
  });

  const inBaseOrder: MapRow[] = [];
  const labelled = base.labels !== null && version.labels !== null;
  const textKnown = base.withText !== null || version.withText !== null;
  let sheet = 0;
  while (sheet < map.from) {
    const run = runAt.get(sheet);
    if (run !== undefined) {
      const { start, proposed } = map.runs[run];
      inBaseOrder.push({ kind: "run", run, base: [start + 1, start + proposed.length], version: proposed.map((to) => to + 1) });
      sheet = start + proposed.length;
      continue;
    }
    const to = map.sheets[sheet];
    let end = sheet + 1;
    if (to >= 0) {
      while (end < map.from && !runAt.has(end) && map.sheets[end] === to + (end - sheet)) end++;
      let agree = 0;
      const differ: number[] = [];
      const without: number[] = [];
      for (let from = sheet; from < end; from++) {
        const counterpart = to + (from - sheet);
        if (labelled) {
          const a = labelKey(base.labels!, from);
          const b = labelKey(version.labels!, counterpart);
          if (a !== "" && a === b) agree++;
          else if (a !== "" || b !== "") differ.push(from + 1);
        }
        if ((base.withText && !base.withText.has(from)) || (version.withText && !version.withText.has(counterpart))) without.push(from + 1);
      }
      inBaseOrder.push({
        kind: "matched",
        base: [sheet + 1, end],
        version: [to + 1, to + (end - sheet)],
        offset: to - sheet,
        labelsAgree: labelled ? agree : null,
        labelsDiffer: labelled ? differ : null,
        withoutText: textKnown ? without : null,
      });
    } else {
      while (end < map.from && !runAt.has(end) && map.sheets[end] === to) end++;
      inBaseOrder.push({ kind: to === REMOVED ? "removed" : "unmapped", base: [sheet + 1, end] });
    }
    sheet = end;
  }

  // Which row holds each sheet of the version. A sheet a run proposes is that
  // run's, whatever its answer; any other with a sheet of the base going to it
  // is its stretch's.
  const holder = new Map<number, number>();
  inBaseOrder.forEach((row, index) => {
    if (row.kind === "run") for (const to of row.version) if (!holder.has(to - 1)) holder.set(to - 1, index);
    if (row.kind === "matched") for (let to = row.version[0] - 1; to < row.version[1]; to++) if (!holder.has(to)) holder.set(to, index);
  });

  // Added stretches, keyed by the row each follows: -1 for before every row.
  const after = new Map<number, MapRow[]>();
  for (let to = 0; to < map.to; ) {
    if (holder.has(to)) {
      to++;
      continue;
    }
    let end = to + 1;
    while (end < map.to && !holder.has(end)) end++;
    // The sheet before is held, the stretch being as long as it goes; a map
    // whose holder is missing for it all the same puts the stretch last.
    const follows = to === 0 ? -1 : (holder.get(to - 1) ?? inBaseOrder.length - 1);
    const list = after.get(follows) ?? [];
    list.push({ kind: "added", version: [to + 1, end] });
    after.set(follows, list);
    to = end;
  }

  const rows: MapRow[] = [...(after.get(-1) ?? [])];
  inBaseOrder.forEach((row, index) => {
    rows.push(row, ...(after.get(index) ?? []));
  });
  return rows;
}

/** Consecutive numbers as `[first, last]` ranges, in the order given. */
export function sheetRanges(sheets: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const sheet of sheets) {
    const open = out[out.length - 1];
    if (open && open[1] + 1 === sheet) open[1] = sheet;
    else out.push([sheet, sheet]);
  }
  return out;
}

/**
 * The printed pages some sheets carry, as a row names them: "p. 2",
 * "pp. xiii–xxix", from the first and the last of them that has a label, in
 * the order given. Null where none has one, or where the version's labels
 * aren't usable (`labels` null), since a sheet's number is then all a page
 * number would say. Sheets are 1-based.
 */
export function pagesOf(labels: readonly string[] | null, sheets: readonly number[]): string | null {
  if (labels === null) return null;
  const named = sheets.map((sheet) => (labels[sheet - 1] ?? "").trim()).filter((label) => label !== "");
  if (named.length === 0) return null;
  const first = named[0];
  const last = named[named.length - 1];
  return named.length === 1 || first === last ? `p. ${first}` : `pp. ${first}–${last}`;
}

/** Every sheet of a row on one side, 1-based, in its order: none for a side the row has no sheet on. */
export function rowSheetsOn(row: MapRow, side: "base" | "version"): number[] {
  const range = ([first, last]: [number, number]) => Array.from({ length: last - first + 1 }, (_, k) => first + k);
  if (side === "base") return row.kind === "added" ? [] : range(row.base);
  if (row.kind === "run") return row.version;
  return row.kind === "matched" || row.kind === "added" ? range(row.version) : [];
}
