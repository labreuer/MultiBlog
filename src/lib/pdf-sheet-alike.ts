// docs/PDF.md §13, "Matching the pages": how alike two sheets of two versions
// of a file must be for a page map to pair them. Two sheets are alike when
// each holds the other's words, not when one holds the other's among more.
//
// Pure, and over skeletons alone (`skeletonOf(text).text`, pdf-fragment.ts),
// so nothing here depends on spacing, hyphens or quotation marks.
//
// Two numbers, each taken both ways round, because one can't do it: a page
// read badly in one scan and a page that lost three lines to its neighbours
// share the same amount of text with their counterparts. The values were
// settled on real pairs of files (§13, "How the numbers were measured"), so
// changing one means measuring again.

/** The length of the runs of letters `sheetShare` counts. */
export const SHARE_RUN = 4;
/** Two sheets are the same page when each holds at least this share of the other's runs. */
export const ALIKE_SHARE = 0.55;
/** The length of the runs of letters `sheetMoved` looks for on a neighbour. */
export const MOVED_RUN = 16;
/** A sheet kept its place when no more than this share of either sheet's letters moved. */
export const ALIKE_MOVED = 0.05;

/** A sheet's skeleton with those of the sheets before and after it in its version, "" where there is none. */
export type SheetInPlace = { skeleton: string; before: string; after: string };

/**
 * Whether a skeleton has a run to compare. One that doesn't counts as a sheet
 * without text, which the map places by its neighbours (rule 5).
 */
export function hasRunsToCompare(skeleton: string): boolean {
  return skeleton.length >= SHARE_RUN;
}

function runCounts(skeleton: string, length: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let at = 0; at + length <= skeleton.length; at++) {
    const run = skeleton.slice(at, at + length);
    counts.set(run, (counts.get(run) ?? 0) + 1);
  }
  return counts;
}

/**
 * Of the runs of four letters in `sheet`, the share `other` holds. A run
 * counts as often as it occurs, and each of `other`'s answers for one of
 * `sheet`'s. Order plays no part, so a page whose columns are read in another
 * order keeps its share. 0 for a sheet with no run.
 */
export function sheetShare(sheet: string, other: string): number {
  const own = runCounts(sheet, SHARE_RUN);
  const theirs = runCounts(other, SHARE_RUN);
  let total = 0;
  let held = 0;
  for (const [run, count] of own) {
    total += count;
    held += Math.min(count, theirs.get(run) ?? 0);
  }
  return total === 0 ? 0 : held / total;
}

/**
 * The share of `sheet`'s letters that lie in a run of 16 letters which the
 * sheet before or after `other` holds, and in no run of 16 which `other`
 * holds. Words a bad reading lost are on no sheet; words a reflow moved are
 * on the neighbour.
 */
export function sheetMoved(sheet: string, other: string, otherBefore: string, otherAfter: string): number {
  if (sheet.length < MOVED_RUN) return 0;
  const runsOf = (skeleton: string, into: Set<string>) => {
    for (let at = 0; at + MOVED_RUN <= skeleton.length; at++) into.add(skeleton.slice(at, at + MOVED_RUN));
    return into;
  };
  const own = runsOf(other, new Set());
  const near = runsOf(otherAfter, runsOf(otherBefore, new Set()));
  const held = new Uint8Array(sheet.length);
  const elsewhere = new Uint8Array(sheet.length);
  for (let at = 0; at + MOVED_RUN <= sheet.length; at++) {
    const run = sheet.slice(at, at + MOVED_RUN);
    if (own.has(run)) held.fill(1, at, at + MOVED_RUN);
    else if (near.has(run)) elsewhere.fill(1, at, at + MOVED_RUN);
  }
  let moved = 0;
  for (let at = 0; at < sheet.length; at++) if (elsewhere[at] && !held[at]) moved++;
  return moved / sheet.length;
}

/**
 * Whether a page map may pair the two sheets unasked: each holds the other's
 * runs, and neither's letters are on the other's neighbours instead.
 */
export function sheetsAlike(a: SheetInPlace, b: SheetInPlace): boolean {
  if (!hasRunsToCompare(a.skeleton) || !hasRunsToCompare(b.skeleton)) return false;
  if (sheetShare(a.skeleton, b.skeleton) < ALIKE_SHARE || sheetShare(b.skeleton, a.skeleton) < ALIKE_SHARE) return false;
  return (
    sheetMoved(a.skeleton, b.skeleton, b.before, b.after) <= ALIKE_MOVED &&
    sheetMoved(b.skeleton, a.skeleton, a.before, a.after) <= ALIKE_MOVED
  );
}

/**
 * The runs of four letters of many sheets, each given a number, so that two
 * sheets' runs are compared as sorted lists of numbers. A page map's builder
 * compares a sheet with many others (rule 3's alignment), and counting each
 * sheet's runs anew for every pair is most of what that would cost.
 */
export class RunBook {
  private ids = new Map<string, number>();

  /** A skeleton's runs of four letters as their numbers, sorted, each as often as it occurs. */
  runsOf(skeleton: string): Uint32Array {
    const runs = new Uint32Array(Math.max(0, skeleton.length - SHARE_RUN + 1));
    for (let at = 0; at < runs.length; at++) {
      const run = skeleton.slice(at, at + SHARE_RUN);
      let id = this.ids.get(run);
      if (id === undefined) {
        id = this.ids.size;
        this.ids.set(run, id);
      }
      runs[at] = id;
    }
    return runs.sort();
  }
}

/** A sheet in its place with its runs numbered in one `RunBook`: what `preparedAlike` compares. */
export type PreparedSheet = SheetInPlace & { runs: Uint32Array };

/** Each of a version's sheets in its place, its runs numbered in `book`. Two versions compared share one book. */
export function prepareSheets(skeletons: readonly string[], book: RunBook): PreparedSheet[] {
  return skeletons.map((skeleton, index) => ({
    skeleton,
    before: skeletons[index - 1] ?? "",
    after: skeletons[index + 1] ?? "",
    runs: book.runsOf(skeleton),
  }));
}

/** How many runs two sorted lists hold in common, each of one list's answering for one of the other's. */
function sharedRuns(a: Uint32Array, b: Uint32Array): number {
  let shared = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return shared;
}

/**
 * `sheetsAlike` for two sheets prepared in one `RunBook`: the same answer,
 * with the share read from the numbered runs. Words moved to a neighbour are
 * looked for only once the share has passed, which is for few pairs.
 */
export function preparedAlike(a: PreparedSheet, b: PreparedSheet): boolean {
  if (!hasRunsToCompare(a.skeleton) || !hasRunsToCompare(b.skeleton)) return false;
  const shared = sharedRuns(a.runs, b.runs);
  // Divided, as `sheetShare` divides: multiplied out, a share of exactly 0.55 falls a rounding short.
  if (shared / a.runs.length < ALIKE_SHARE || shared / b.runs.length < ALIKE_SHARE) return false;
  return (
    sheetMoved(a.skeleton, b.skeleton, b.before, b.after) <= ALIKE_MOVED &&
    sheetMoved(b.skeleton, a.skeleton, a.before, a.after) <= ALIKE_MOVED
  );
}
