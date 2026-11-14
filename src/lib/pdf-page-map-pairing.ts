import { UNMAPPED, classifyUnpaired, type PageMap, type PageMapRun } from "./pdf-page-map";
import { RunBook, hasRunsToCompare, prepareSheets, preparedAlike, type PreparedSheet } from "./pdf-sheet-alike";

// docs/PDF.md §13, "Matching the pages" — the rules that pair the sheets of a
// version with those of its base, in order of trust:
//
// 1. by label, where both versions have usable labels;
// 2. a label's answer checked by text, and a sheet without text by its
//    neighbours;
// 3. by text, where labels can't decide: the two sequences of sheets aligned
//    as a diff aligns lines, two sheets equal when they are alike;
// 4. blank sheets, which are known insertions and deletions;
// 5. sheets with ink but no text, placed between their aligned neighbours
//    when the run between them has the same length in both versions;
// 6. a sheet with text that no rule pairs, proposed the sheet at its place
//    for a person to accept.
//
// Pure: it is given each sheet's skeleton, own label and whether it draws
// anything, and answers the map. `src/lib/pdf-page-map-build.ts` reads those
// from a version's stored text and its bytes.

/** One sheet of a version, as the rules read it. */
export type SheetFacts = {
  /** Its text's skeleton (`skeletonOf(text).text`). Shorter than four letters, it counts as a sheet without text. */
  skeleton: string;
  /** The label the file itself gives it, "" for none. */
  label: string;
  /** Whether it draws anything. Read only of a sheet without text, where it tells a blank sheet from a plate. */
  ink: boolean;
};

/** A version's sheets in order, and whether its labels are usable (`usablePageLabels`). */
export type VersionSheets = { sheets: readonly SheetFacts[]; usableLabels: boolean };

/**
 * For each of `n` things the one of `m` it is aligned with, or -1: a longest
 * run of pairs, in order, that `equal` holds for, found as a diff finds one
 * (Myers' O(ND)). So two versions of one text cost about as many comparisons
 * as they have sheets, where comparing every sheet with every sheet would
 * cost their product. `equal` need not be transitive.
 */
export function alignInOrder(n: number, m: number, equal: (i: number, j: number) => boolean): Int32Array {
  const aligned = new Int32Array(n).fill(-1);
  if (n === 0 || m === 0) return aligned;
  const memo = new Map<number, boolean>();
  const same = (i: number, j: number) => {
    const key = i * m + j;
    let answer = memo.get(key);
    if (answer === undefined) {
      answer = equal(i, j);
      memo.set(key, answer);
    }
    return answer;
  };
  const max = n + m;
  // `reach[max + k]` is the farthest x on diagonal k (x - y = k).
  const reach = new Int32Array(2 * max + 2);
  // Before each round, the diagonals it reads: [-d - 1, d + 1].
  const trace: Int32Array[] = [];
  let rounds = -1;
  for (let d = 0; d <= max && rounds < 0; d++) {
    trace.push(reach.slice(max - d - 1 < 0 ? 0 : max - d - 1, max + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && reach[max + k - 1] < reach[max + k + 1]) ? reach[max + k + 1] : reach[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(x, y)) {
        x++;
        y++;
      }
      reach[max + k] = x;
      if (x >= n && y >= m) {
        rounds = d;
        break;
      }
    }
  }
  // Back along the path: each round's snake is a run of aligned pairs.
  let x = n;
  let y = m;
  for (let d = rounds; d >= 0; d--) {
    const before = trace[d];
    const low = max - d - 1 < 0 ? 0 : max - d - 1;
    const at = (k: number) => before[max + k - low];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const fromK = down ? k + 1 : k - 1;
    const startX = d === 0 ? 0 : down ? at(fromK) : at(fromK) + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      x--;
      y--;
      aligned[x] = y;
    }
    if (d === 0) break;
    x = at(fromK);
    y = x - fromK;
  }
  return aligned;
}

type Pillar = { base: number; to: number; definite: boolean };

/**
 * The pairs a gap between two pillars takes by place: the sheets of the base
 * and of the version that nothing has paired, in order. The whole gap pairs
 * one for one where it is the same length on both sides and a blank sheet
 * faces a blank one. Otherwise the blank sheets are taken out, as known
 * insertions and deletions (rule 4), and what is left pairs where it is the
 * same length. No pair otherwise.
 */
function pairsByPlace(baseGap: readonly number[], versionGap: readonly number[], blankBase: ReadonlySet<number>, blankVersion: ReadonlySet<number>): [number, number][] {
  const zip = (from: readonly number[], to: readonly number[]) => from.map((sheet, k): [number, number] => [sheet, to[k]]);
  if (baseGap.length === versionGap.length && baseGap.every((sheet, k) => blankBase.has(sheet) === blankVersion.has(versionGap[k]))) {
    return zip(baseGap, versionGap);
  }
  const inked = baseGap.filter((sheet) => !blankBase.has(sheet));
  const inkedTo = versionGap.filter((sheet) => !blankVersion.has(sheet));
  return inked.length > 0 && inked.length === inkedTo.length ? zip(inked, inkedTo) : [];
}

/**
 * The page map between a version and its base (docs/PDF.md §13, "Matching the
 * pages"), with every question its runs of sheets raise left open.
 */
export function pairSheets(base: VersionSheets, version: VersionSheets): PageMap {
  const n = base.sheets.length;
  const m = version.sheets.length;
  const book = new RunBook();
  const from: PreparedSheet[] = prepareSheets(
    base.sheets.map((sheet) => sheet.skeleton),
    book,
  );
  const to: PreparedSheet[] = prepareSheets(
    version.sheets.map((sheet) => sheet.skeleton),
    book,
  );
  const textFrom = from.map((sheet) => hasRunsToCompare(sheet.skeleton));
  const textTo = to.map((sheet) => hasRunsToCompare(sheet.skeleton));
  const blankBase = new Set(base.sheets.flatMap((sheet, index) => (!textFrom[index] && !sheet.ink ? [index] : [])));
  const blankVersion = new Set(version.sheets.flatMap((sheet, index) => (!textTo[index] && !sheet.ink ? [index] : [])));

  // Rule 1: the sheet each label gives. A label on several sheets maps the
  // k-th carrying it in the base to the k-th in the version, where both have
  // the same number of sheets with it. Read as a `p=` reads a label:
  // trimmed, in any case, and an empty one is none.
  const byLabel: (number | null)[] = new Array<number | null>(n).fill(null);
  if (base.usableLabels && version.usableLabels) {
    const group = (sheets: readonly SheetFacts[]) => {
      const groups = new Map<string, number[]>();
      sheets.forEach((sheet, index) => {
        const key = sheet.label.trim().toLowerCase();
        if (key === "") return;
        const held = groups.get(key);
        if (held) held.push(index);
        else groups.set(key, [index]);
      });
      return groups;
    };
    const versionLabels = group(version.sheets);
    for (const [key, sheets] of group(base.sheets)) {
      const counterparts = versionLabels.get(key);
      if (counterparts?.length === sheets.length) sheets.forEach((sheet, k) => (byLabel[sheet] = counterparts[k]));
    }
  }

  // Rule 2: a label's answer stands only where the two sheets are alike.
  // `kept` is undefined for a sheet the labels gave nothing.
  const kept: (boolean | undefined)[] = new Array<boolean | undefined>(n).fill(undefined);
  const checked: boolean[] = new Array<boolean>(n).fill(false);
  for (let sheet = 0; sheet < n; sheet++) {
    const given = byLabel[sheet];
    if (given === null || !textFrom[sheet] || !textTo[given]) continue;
    checked[sheet] = true;
    kept[sheet] = preparedAlike(from[sheet], to[given]);
  }
  // A sheet without text, or whose counterpart has none, is checked by its
  // neighbours: it keeps its label's answer unless the nearest sheet before
  // it or after it whose answer the text checked lost its own. Otherwise one
  // plate in a stretch of shifted labels would keep a wrong answer and split
  // the run in two.
  const lostBefore: boolean[] = new Array<boolean>(n).fill(false);
  let last: boolean | undefined;
  for (let sheet = 0; sheet < n; sheet++) {
    lostBefore[sheet] = last === false;
    if (checked[sheet]) last = kept[sheet];
  }
  last = undefined;
  for (let sheet = n - 1; sheet >= 0; sheet--) {
    if (byLabel[sheet] !== null && !checked[sheet]) kept[sheet] = !(lostBefore[sheet] || last === false);
    if (checked[sheet]) last = kept[sheet];
  }

  const sheets: number[] = new Array<number>(n).fill(UNMAPPED);
  const taken = new Set<number>();
  const proposals = new Map<number, { to: number; kind: PageMapRun["kind"] }>();
  for (let sheet = 0; sheet < n; sheet++) {
    if (kept[sheet] !== true) continue;
    sheets[sheet] = byLabel[sheet]!;
    taken.add(byLabel[sheet]!);
  }

  // Rule 3: by text, for every sheet with text the labels left undecided.
  // One alignment over the whole of both versions. A sheet the labels said
  // nothing of takes its counterpart unasked. One whose label's answer the
  // text refused is proposed its counterpart, for a person to accept.
  const undecided = sheets.some((to_, sheet) => to_ < 0 && textFrom[sheet]);
  const aligned = undecided ? alignInOrder(n, m, (i, j) => preparedAlike(from[i], to[j])) : new Int32Array(n).fill(-1);
  for (let sheet = 0; sheet < n; sheet++) {
    const counterpart = aligned[sheet];
    // Unless a label has already given that sheet to another.
    if (sheets[sheet] >= 0 || counterpart < 0 || taken.has(counterpart)) continue;
    if (kept[sheet] === false) continue;
    sheets[sheet] = counterpart;
    taken.add(counterpart);
  }
  for (let sheet = 0; sheet < n; sheet++) {
    const counterpart = aligned[sheet];
    if (sheets[sheet] >= 0 || counterpart < 0 || taken.has(counterpart) || kept[sheet] !== false) continue;
    proposals.set(sheet, { to: counterpart, kind: "labels" });
    taken.add(counterpart);
  }

  // Rules 4 to 6: what stands between two pillars is placed by position. A
  // pillar is a sheet with a counterpart, taken or proposed.
  const pillars: Pillar[] = [{ base: -1, to: -1, definite: true }];
  for (let sheet = 0; sheet < n; sheet++) {
    if (sheets[sheet] >= 0) pillars.push({ base: sheet, to: sheets[sheet], definite: true });
    else if (proposals.has(sheet)) pillars.push({ base: sheet, to: proposals.get(sheet)!.to, definite: false });
  }
  pillars.push({ base: n, to: m, definite: true });
  for (let at = 0; at + 1 < pillars.length; at++) {
    const before = pillars[at];
    const after = pillars[at + 1];
    if (after.base - before.base < 2 || before.to >= after.to) continue;
    const versionGap: number[] = [];
    let crossed = false;
    for (let sheet = before.to + 1; sheet < after.to; sheet++) {
      if (taken.has(sheet)) crossed = true;
      else versionGap.push(sheet);
    }
    // A sheet of the version between the two that is already another's: the
    // pillars cross, and nothing says what stands where.
    if (crossed) continue;
    const baseGap = Array.from({ length: after.base - before.base - 1 }, (_, k) => before.base + 1 + k);
    for (const [sheet, counterpart] of pairsByPlace(baseGap, versionGap, blankBase, blankVersion)) {
      taken.add(counterpart);
      if (textFrom[sheet] && textTo[counterpart]) {
        // Rule 6: both have text, too unlike for the map to pair them unasked.
        proposals.set(sheet, { to: counterpart, kind: "place" });
      } else if (before.definite && after.definite && kept[sheet] !== false) {
        // Rule 5, and a blank sheet facing a blank one.
        sheets[sheet] = counterpart;
      } else {
        // Its place rests on a proposal, or it lost its label's answer with its neighbours: it joins their run.
        proposals.set(sheet, { to: counterpart, kind: "labels" });
      }
    }
  }

  // Consecutive sheets with the same question are one run.
  const runs: PageMapRun[] = [];
  for (let sheet = 0; sheet < n; sheet++) {
    const proposal = proposals.get(sheet);
    if (!proposal) continue;
    const open = runs[runs.length - 1];
    if (open && open.kind === proposal.kind && open.start + open.proposed.length === sheet) {
      open.proposed.push(proposal.to);
      open.byLabel?.push(byLabel[sheet]);
    } else {
      runs.push({ kind: proposal.kind, start: sheet, proposed: [proposal.to], ...(proposal.kind === "labels" ? { byLabel: [byLabel[sheet]] } : {}), answer: null });
    }
  }

  return classifyUnpaired({ from: n, to: m, sheets, runs, blank: { from: [...blankBase], to: [...blankVersion] } });
}
