import { diffText, TooLargeToMerge, type CapMode } from "./diff";

// docs/MCP.md §6 — pairing two versions of a run of blocks, and the word diff
// within each pair. One alignment for three callers: a read of what changed
// since a version, a targeted edit (whose replacement is aligned with the text
// it replaces, so the words that survive keep their marks), and reverting an
// edit from its log row.
//
// Pure and browser-safe; block-align.test.ts is its table.

/** One step of an alignment: a pair, an old block with no counterpart (deleted), or a new one (added). */
export type AlignedPair = { old: number | null; new: number | null };

/** A text's words, case folded and counted, for telling how alike two blocks are. */
type Words = { text: string; counts: Map<string, number>; total: number };

function wordsOf(text: string): Words {
  const counts = new Map<string, number>();
  let total = 0;
  for (const [word] of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
    total++;
  }
  return { text, counts, total };
}

function similarityOf(a: Words, b: Words): number {
  if (a.total === 0 && b.total === 0) return a.text === b.text ? 1 : 0.5;
  if (a.total === 0 || b.total === 0) return 0;
  const [fewer, more] = a.counts.size <= b.counts.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [word, count] of fewer.counts) shared += Math.min(count, more.counts.get(word) ?? 0);
  return (2 * shared) / (a.total + b.total);
}

/** How alike two texts are: the Dice coefficient of their word multisets, 0 to 1. */
export function similarity(a: string, b: string): number {
  return similarityOf(wordsOf(a), wordsOf(b));
}

/** Below this, two blocks in a gap are a deletion and an addition rather than a rewrite of one another. */
const PAIRING_THRESHOLD = 0.3;

/**
 * The blocks between two anchors, paired: in order, and each pair the most
 * alike the order allows (a dynamic program maximising the summed
 * similarity), so a block inserted between two rewritten ones is an addition
 * rather than the cause of every later pairing sliding one block over. A pair
 * less alike than the threshold is left as a deletion and an addition.
 *
 * Every block is scored against every block across the gap, so each block's
 * words are counted once, not once per pair.
 */
function pairGap(a: readonly string[], b: readonly string[]): [number | null, number | null][] {
  if (a.length === 0) return b.map((_, j) => [null, j]);
  if (b.length === 0) return a.map((_, i) => [i, null]);
  if (a.length === 1 && b.length === 1) return [[0, 0]];
  const wordsB = b.map(wordsOf);
  const sim = a.map((x) => {
    const words = wordsOf(x);
    return wordsB.map((y) => similarityOf(words, y));
  });
  const best: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const pair = sim[i][j] >= PAIRING_THRESHOLD ? sim[i][j] + best[i + 1][j + 1] : -Infinity;
      best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1]);
    }
  }
  const out: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (sim[i][j] >= PAIRING_THRESHOLD && best[i][j] === sim[i][j] + best[i + 1][j + 1]) {
      out.push([i++, j++]);
    } else if (best[i][j] === best[i + 1][j]) {
      out.push([i++, null]);
    } else {
      out.push([null, j++]);
    }
  }
  while (i < a.length) out.push([i++, null]);
  while (j < b.length) out.push([null, j++]);
  return out;
}

/** A gap left unpaired: its old blocks deleted, then its new ones added. */
function unpaired(oldCount: number, newCount: number): [number | null, number | null][] {
  return [
    ...Array.from({ length: oldCount }, (_, i): [number | null, number | null] => [i, null]),
    ...Array.from({ length: newCount }, (_, j): [number | null, number | null] => [null, j]),
  ];
}

/**
 * The alignment's cap, in table cells once the equal ends are trimmed: 5,000
 * blocks a side, 50 MB as a `Uint16Array`. Under it the shorter side has at
 * most 5,000 blocks, so no entry of the table, a common subsequence's length,
 * can pass 65,535.
 */
export const ALIGNMENT_MAX_CELLS = 25_000_000;

/**
 * Pairing's cap: the pairs `pairGap` scores, summed over every gap, since
 * shared empty paragraphs can split two unrelated runs of blocks into gaps
 * that each pass a cap per gap. A 1×1 gap is paired without being scored, so
 * it counts for nothing.
 */
export const PAIRING_MAX_PAIRS = 1_000_000;

/**
 * Pairs `oldTexts` with `newTexts`, by index. Blocks whose key is identical
 * anchor the alignment (a longest common subsequence over whole blocks; the
 * key is the text unless the caller passes keys of its own — a write-back
 * passes each block's JSON, so a block whose marks changed isn't an anchor);
 * between two anchors the leftover blocks are paired by how alike their texts
 * are (`pairGap`), and whatever is left over after that is added or deleted
 * whole. Pairing is what lets a rewritten paragraph be diffed word by word
 * against the paragraph it replaced, rather than deleted and added as a
 * stranger.
 *
 * Equal ends are taken first, so a long doc with an edit in the middle costs
 * a table over the middle only.
 *
 * Two caps bound the rest. Past `ALIGNMENT_MAX_CELLS`, a read gets everything
 * between the equal ends deleted and added; past `PAIRING_MAX_PAIRS`, every
 * gap larger than 1×1 is left unpaired. An edit past either throws
 * `TooLargeToMerge`.
 */
export function alignBlocks(
  oldTexts: readonly string[],
  newTexts: readonly string[],
  keys?: { old: readonly string[]; new: readonly string[] },
  mode: CapMode = "read",
): AlignedPair[] {
  const oldKeys = keys?.old ?? oldTexts;
  const newKeys = keys?.new ?? newTexts;
  let head = 0;
  while (head < oldKeys.length && head < newKeys.length && oldKeys[head] === newKeys[head]) head++;
  let tail = 0;
  while (
    tail < oldKeys.length - head &&
    tail < newKeys.length - head &&
    oldKeys[oldKeys.length - 1 - tail] === newKeys[newKeys.length - 1 - tail]
  ) {
    tail++;
  }

  const a = oldKeys.slice(head, oldKeys.length - tail);
  const b = newKeys.slice(head, newKeys.length - tail);
  const n = a.length;
  const m = b.length;

  const pairs: AlignedPair[] = [];
  for (let k = 0; k < head; k++) pairs.push({ old: k, new: k });
  const push = (gap: [number | null, number | null][], i: number, j: number) => {
    for (const [x, y] of gap) pairs.push({ old: x === null ? null : head + i + x, new: y === null ? null : head + j + y });
  };
  const finish = () => {
    for (let k = 0; k < tail; k++) pairs.push({ old: oldKeys.length - tail + k, new: newKeys.length - tail + k });
    return pairs;
  };

  if (n * m > ALIGNMENT_MAX_CELLS) {
    if (mode === "edit") throw new TooLargeToMerge();
    push(unpaired(n, m), 0, 0);
    return finish();
  }

  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const at = i * width + j;
      dp[at] = a[i] === b[j] ? dp[at + width + 1] + 1 : Math.max(dp[at + width], dp[at + 1]);
    }
  }

  // The anchors, each after the gap before it, and the gap after the last.
  const gaps: { i: number; iEnd: number; j: number; jEnd: number }[] = [];
  let i = 0;
  let j = 0;
  let ii = 0;
  let jj = 0;
  while (ii < n && jj < m) {
    if (a[ii] === b[jj]) {
      gaps.push({ i, iEnd: ii, j, jEnd: jj });
      i = ++ii;
      j = ++jj;
    } else if (dp[(ii + 1) * width + jj] >= dp[ii * width + jj + 1]) {
      ii++;
    } else {
      jj++;
    }
  }
  gaps.push({ i, iEnd: n, j, jEnd: m });

  const scored = (gap: (typeof gaps)[number]) => {
    const cells = (gap.iEnd - gap.i) * (gap.jEnd - gap.j);
    return cells > 1 ? cells : 0;
  };
  const tooMany = gaps.reduce((sum, gap) => sum + scored(gap), 0) > PAIRING_MAX_PAIRS;
  if (tooMany && mode === "edit") throw new TooLargeToMerge();

  for (const [k, gap] of gaps.entries()) {
    push(
      tooMany && scored(gap) > 0
        ? unpaired(gap.iEnd - gap.i, gap.jEnd - gap.j)
        : pairGap(oldTexts.slice(head + gap.i, head + gap.iEnd), newTexts.slice(head + gap.j, head + gap.jEnd)),
      gap.i,
      gap.j,
    );
    if (k < gaps.length - 1) pairs.push({ old: head + gap.iEnd, new: head + gap.jEnd });
  }
  return finish();
}

/** A word diff's runs: equal text, or text removed and text added, in order. */
export type DiffRun = { type: "equal" | "delete" | "insert"; text: string; start: number; end: number };

/**
 * `diffText`'s tokens merged into runs, each with its span in the text it
 * belongs to (the old text for a deletion, the new for an insertion and an
 * equal run). A change region runs across the whitespace between two changes,
 * so "the quick brown fox" against "the slow red fox" is one removal and one
 * addition, `[-quick brown-]{+slow red+}`, rather than two of each.
 */
export function diffRuns(oldText: string, newText: string): DiffRun[] {
  const tokens = diffText(oldText, newText);
  const runs: DiffRun[] = [];
  let oldAt = 0;
  let newAt = 0;
  let k = 0;
  while (k < tokens.length) {
    const token = tokens[k];
    if (token.type === "equal") {
      const last = runs[runs.length - 1];
      if (last?.type === "equal") {
        last.text += token.value;
        last.end = newAt + token.value.length;
      } else {
        runs.push({ type: "equal", text: token.value, start: newAt, end: newAt + token.value.length });
      }
      oldAt += token.value.length;
      newAt += token.value.length;
      k++;
      continue;
    }
    // A change region: changed tokens, and whitespace between two of them.
    let end = k;
    while (end < tokens.length) {
      const t = tokens[end];
      if (t.type !== "equal") {
        end++;
        continue;
      }
      const after = tokens[end + 1];
      if (/^\s+$/.test(t.value) && after && after.type !== "equal") {
        end++;
        continue;
      }
      break;
    }
    let removed = "";
    let added = "";
    const oldStart = oldAt;
    const newStart = newAt;
    for (const t of tokens.slice(k, end)) {
      if (t.type !== "insert") {
        removed += t.value;
        oldAt += t.value.length;
      }
      if (t.type !== "delete") {
        added += t.value;
        newAt += t.value.length;
      }
    }
    if (removed.trim() !== "" || added.trim() === "") {
      runs.push({ type: "delete", text: removed, start: oldStart, end: oldAt });
    }
    if (added.trim() !== "") runs.push({ type: "insert", text: added, start: newStart, end: newAt });
    k = end;
  }
  return runs.filter((run) => run.text !== "");
}

/** A word diff as one string, git's word-diff markers: `[-removed-]` and `{+added+}`. */
export function renderWordDiff(runs: readonly DiffRun[]): string {
  return runs
    .map((run) => (run.type === "equal" ? run.text : run.type === "delete" ? `[-${run.text}-]` : `{+${run.text}+}`))
    .join("");
}
