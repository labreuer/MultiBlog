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

/**
 * Pairs `oldTexts` with `newTexts`, by index. Blocks whose text is identical
 * anchor the alignment (a longest common subsequence over whole blocks);
 * between two anchors the leftover blocks are paired in order, and whatever is
 * left over after that is added or deleted whole. Pairing in order is what
 * lets a rewritten paragraph be diffed word by word against the paragraph it
 * replaced, rather than deleted and added as a stranger.
 *
 * Equal ends are taken first, so a long doc with an edit in the middle costs
 * a table over the middle only.
 */
export function alignBlocks(oldTexts: readonly string[], newTexts: readonly string[]): AlignedPair[] {
  let head = 0;
  while (head < oldTexts.length && head < newTexts.length && oldTexts[head] === newTexts[head]) head++;
  let tail = 0;
  while (
    tail < oldTexts.length - head &&
    tail < newTexts.length - head &&
    oldTexts[oldTexts.length - 1 - tail] === newTexts[newTexts.length - 1 - tail]
  ) {
    tail++;
  }

  const a = oldTexts.slice(head, oldTexts.length - tail);
  const b = newTexts.slice(head, newTexts.length - tail);
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

  // The anchors, then the gaps between them paired in order.
  let i = 0;
  let j = 0;
  const flushGap = (iEnd: number, jEnd: number) => {
    while (i < iEnd && j < jEnd) pairs.push({ old: head + i++, new: head + j++ });
    while (i < iEnd) pairs.push({ old: head + i++, new: null });
    while (j < jEnd) pairs.push({ old: null, new: head + j++ });
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

  for (let k = 0; k < tail; k++) pairs.push({ old: oldTexts.length - tail + k, new: newTexts.length - tail + k });
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
