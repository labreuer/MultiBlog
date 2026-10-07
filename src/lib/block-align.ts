import { diffText } from "./diff";

// docs/MCP.md §6 — pairing two versions of a run of blocks, and the word diff
// within each pair. One alignment for three callers: a read of what changed
// since a version, a targeted edit (whose replacement is aligned with the text
// it replaces, so the words that survive keep their marks), and reverting an
// edit from its log row.
//
// Pure and browser-safe; block-align.test.ts is its table.

/** One step of an alignment: a pair, an old block with no counterpart (deleted), or a new one (added). */
export type AlignedPair = { old: number | null; new: number | null };

/** The words of a text, case folded, for telling how alike two blocks are. */
function wordsOf(text: string): string[] {
  return [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
}

/** How alike two texts are: the Dice coefficient of their word multisets, 0 to 1. */
export function similarity(a: string, b: string): number {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.length === 0 && wb.length === 0) return a === b ? 1 : 0.5;
  if (wa.length === 0 || wb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

/** Below this, two blocks in a gap are a deletion and an addition rather than a rewrite of one another. */
const PAIRING_THRESHOLD = 0.3;

/**
 * The blocks between two anchors, paired: in order, and each pair the most
 * alike the order allows (a dynamic program maximising the summed
 * similarity), so a block inserted between two rewritten ones is an addition
 * rather than the cause of every later pairing sliding one block over. A pair
 * less alike than the threshold is left as a deletion and an addition.
 */
function pairGap(a: readonly string[], b: readonly string[]): [number | null, number | null][] {
  if (a.length === 0) return b.map((_, j) => [null, j]);
  if (b.length === 0) return a.map((_, i) => [i, null]);
  if (a.length === 1 && b.length === 1) return [[0, 0]];
  const sim = a.map((x) => b.map((y) => similarity(x, y)));
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
 */
export function alignBlocks(
  oldTexts: readonly string[],
  newTexts: readonly string[],
  keys?: { old: readonly string[]; new: readonly string[] },
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
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: AlignedPair[] = [];
  for (let k = 0; k < head; k++) pairs.push({ old: k, new: k });

  // The anchors, then the gaps between them paired by likeness.
  let i = 0;
  let j = 0;
  const flushGap = (iEnd: number, jEnd: number) => {
    const gap = pairGap(oldTexts.slice(head + i, head + iEnd), newTexts.slice(head + j, head + jEnd));
    for (const [x, y] of gap) pairs.push({ old: x === null ? null : head + i + x, new: y === null ? null : head + j + y });
    i = iEnd;
    j = jEnd;
  };
  let ii = 0;
  let jj = 0;
  while (ii < n && jj < m) {
    if (a[ii] === b[jj]) {
      flushGap(ii, jj);
      pairs.push({ old: head + ii, new: head + jj });
      i = ++ii;
      j = ++jj;
    } else if (dp[ii + 1][jj] >= dp[ii][jj + 1]) {
      ii++;
    } else {
      jj++;
    }
  }
  flushGap(n, m);

  for (let k = 0; k < tail; k++) pairs.push({ old: oldKeys.length - tail + k, new: newKeys.length - tail + k });
  return pairs;
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
