import { test } from "node:test";
import assert from "node:assert/strict";
import { alignBlocks, ALIGNMENT_MAX_CELLS, diffRuns, PAIRING_MAX_PAIRS, renderWordDiff, type AlignedPair } from "./block-align";
import { TooLargeToMerge } from "./diff-text";

// docs/MCP.md §6 — the block alignment an edit, a read of changes and a
// revert share, and the word diff within a pair.

test("identical blocks anchor, and the blocks between two anchors pair by likeness", () => {
  assert.deepEqual(alignBlocks(["a", "b", "c"], ["a", "B", "c"]), [
    { old: 0, new: 0 },
    { old: 1, new: 1 },
    { old: 2, new: 2 },
  ]);
  // An insertion between two changed blocks: the changed ones pair with
  // their rewrites by likeness, and the new one is added whole — where
  // pairing in order, as y-prosemirror's own greedy pairing does, would
  // diff the second paragraph against the new one (docs/MCP.md §6, step 3).
  const before = ["Heading", "The first paragraph says one thing.", "The second paragraph says another.", "Tail"];
  const after = [
    "Heading",
    "The first paragraph says one thing, now reworded.",
    "An entirely new paragraph between them.",
    "The second paragraph says another, also reworded.",
    "Tail",
  ];
  assert.deepEqual(alignBlocks(before, after), [
    { old: 0, new: 0 },
    { old: 1, new: 1 },
    { old: null, new: 2 },
    { old: 2, new: 3 },
    { old: 3, new: 4 },
  ]);
});

test("keys anchor the alignment where text alone would, and unlike blocks in a gap aren't paired", () => {
  // Same text, different keys (a mark changed): not an anchor, but still a pair.
  assert.deepEqual(alignBlocks(["a b c", "d e f"], ["a b c", "d e f"], { old: ["k1", "k2"], new: ["k1", "k2*"] }), [
    { old: 0, new: 0 },
    { old: 1, new: 1 },
  ]);
  assert.deepEqual(alignBlocks(["x", "apples and pears", "y"], ["x", "nothing in common here", "y"]), [
    { old: 0, new: 0 },
    { old: 1, new: 1 },
    { old: 2, new: 2 },
  ]);
  assert.deepEqual(
    alignBlocks(["x", "apples and pears", "plums", "y"], ["x", "nothing in common here", "y"]),
    [
      { old: 0, new: 0 },
      { old: 1, new: null },
      { old: 2, new: null },
      { old: null, new: 1 },
      { old: 3, new: 2 },
    ],
  );
});

test("a block that moved is a deletion and an addition, not a rewrite of its neighbours", () => {
  assert.deepEqual(alignBlocks(["a", "b", "c", "d"], ["a", "c", "d", "b"]), [
    { old: 0, new: 0 },
    { old: 1, new: null },
    { old: 2, new: 1 },
    { old: 3, new: 2 },
    { old: null, new: 3 },
  ]);
});

test("pure additions and deletions at either end", () => {
  assert.deepEqual(alignBlocks([], ["x"]), [{ old: null, new: 0 }]);
  assert.deepEqual(alignBlocks(["x", "y"], ["y"]), [
    { old: 0, new: null },
    { old: 1, new: 0 },
  ]);
  assert.deepEqual(alignBlocks(["x"], ["x", "y", "z"]), [
    { old: 0, new: 0 },
    { old: null, new: 1 },
    { old: null, new: 2 },
  ]);
});

test("the word diff marks removals and additions git's way, and joins a run across a space", () => {
  const runs = diffRuns("the quick brown fox jumps", "the slow red fox leaps");
  assert.equal(renderWordDiff(runs), "the [-quick brown-]{+slow red+} fox [-jumps-]{+leaps+}");
  assert.equal(renderWordDiff(diffRuns("same", "same")), "same");
  assert.equal(renderWordDiff(diffRuns("", "added")), "{+added+}");
});

test("an insertion run's span is where its words are in the new text", () => {
  const next = "the slow red fox leaps";
  const runs = diffRuns("the quick brown fox jumps", next);
  const inserts = runs.filter((run) => run.type === "insert");
  assert.deepEqual(
    inserts.map((run) => next.slice(run.start, run.end)),
    inserts.map((run) => run.text),
  );
});

// The size guards (docs/MCP.md §6, "Size guards"). First, the two changes
// that alter no result: each block's words counted once, and the LCS table as
// a Uint16Array. `referenceAlign` is the alignment as it was before them,
// pair by pair, so a random table of inputs can compare the two.

function referenceSimilarity(a: string, b: string): number {
  const wordsOf = (text: string) => [...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);
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

function referencePairGap(a: readonly string[], b: readonly string[]): [number | null, number | null][] {
  if (a.length === 0) return b.map((_, j) => [null, j]);
  if (b.length === 0) return a.map((_, i) => [i, null]);
  if (a.length === 1 && b.length === 1) return [[0, 0]];
  const sim = a.map((x) => b.map((y) => referenceSimilarity(x, y)));
  const best: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const pair = sim[i][j] >= 0.3 ? sim[i][j] + best[i + 1][j + 1] : -Infinity;
      best[i][j] = Math.max(pair, best[i + 1][j], best[i][j + 1]);
    }
  }
  const out: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (sim[i][j] >= 0.3 && best[i][j] === sim[i][j] + best[i + 1][j + 1]) out.push([i++, j++]);
    else if (best[i][j] === best[i + 1][j]) out.push([i++, null]);
    else out.push([null, j++]);
  }
  while (i < a.length) out.push([i++, null]);
  while (j < b.length) out.push([null, j++]);
  return out;
}

function referenceAlign(
  oldTexts: readonly string[],
  newTexts: readonly string[],
  keys?: { old: readonly string[]; new: readonly string[] },
): AlignedPair[] {
  const oldKeys = keys?.old ?? oldTexts;
  const newKeys = keys?.new ?? newTexts;
  let head = 0;
  while (head < oldKeys.length && head < newKeys.length && oldKeys[head] === newKeys[head]) head++;
  let tail = 0;
  while (tail < oldKeys.length - head && tail < newKeys.length - head && oldKeys[oldKeys.length - 1 - tail] === newKeys[newKeys.length - 1 - tail]) tail++;
  const a = oldKeys.slice(head, oldKeys.length - tail);
  const b = newKeys.slice(head, newKeys.length - tail);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs: AlignedPair[] = [];
  for (let k = 0; k < head; k++) pairs.push({ old: k, new: k });
  let i = 0;
  let j = 0;
  const flushGap = (iEnd: number, jEnd: number) => {
    const gap = referencePairGap(oldTexts.slice(head + i, head + iEnd), newTexts.slice(head + j, head + jEnd));
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
    } else if (dp[ii + 1][jj] >= dp[ii][jj + 1]) ii++;
    else jj++;
  }
  flushGap(n, m);
  for (let k = 0; k < tail; k++) pairs.push({ old: oldKeys.length - tail + k, new: newKeys.length - tail + k });
  return pairs;
}

/** A seeded generator, so a failing case can be found again. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("counting words once and the typed table change no alignment, with keys and without", () => {
  const next = random(20261022);
  const vocabulary = ["alpha", "beta", "Gamma", "delta", "the", "a", "fox", "42", "café", "x"];
  const block = () => {
    const roll = next();
    if (roll < 0.1) return "";
    if (roll < 0.15) return "—";
    const count = 1 + Math.floor(next() * 6);
    return Array.from({ length: count }, () => vocabulary[Math.floor(next() * vocabulary.length)]).join(" ");
  };
  for (let run = 0; run < 400; run++) {
    const oldTexts = Array.from({ length: Math.floor(next() * 25) }, block);
    // Keep some blocks, change some, drop some, add some.
    const newTexts = oldTexts.flatMap((text) => {
      const roll = next();
      if (roll < 0.4) return [text];
      if (roll < 0.6) return [`${text} ${block()}`.trim()];
      if (roll < 0.75) return [];
      return [block(), text];
    });
    assert.deepEqual(alignBlocks(oldTexts, newTexts), referenceAlign(oldTexts, newTexts), `run ${run}`);
    // Keys that differ from the texts: some blocks' marks changed.
    const keys = {
      old: oldTexts.map((text, i) => `${text}|${i % 3}`),
      new: newTexts.map((text, i) => `${text}|${i % 3}`),
    };
    assert.deepEqual(alignBlocks(oldTexts, newTexts, keys), referenceAlign(oldTexts, newTexts, keys), `run ${run} with keys`);
  }
});

/** `count` blocks of the form `<prefix> block <i> …`, each unlike any other prefix's. */
const blocks = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix} block ${i} says ${prefix} things`);

test("past the alignment's cap, a read gets everything between the equal ends deleted and added; an edit is refused", () => {
  // Different first and last blocks leave nothing to trim: 5,001 × 5,001 cells.
  const oldTexts = ["old start", ...blocks("same", 4999), "old end"];
  const newTexts = ["new start", ...blocks("same", 4999), "new end"];
  assert.ok(oldTexts.length * newTexts.length > ALIGNMENT_MAX_CELLS);
  const pairs = alignBlocks(oldTexts, newTexts);
  assert.equal(pairs.length, oldTexts.length + newTexts.length);
  assert.deepEqual(pairs.slice(0, 2), [{ old: 0, new: null }, { old: 1, new: null }]);
  assert.deepEqual(pairs[oldTexts.length], { old: null, new: 0 });
  assert.ok(pairs.every((pair) => pair.old === null || pair.new === null));
  assert.throws(() => alignBlocks(oldTexts, newTexts, undefined, "edit"), TooLargeToMerge);

  // A read is told which cap bit; an edit throws before anything is told.
  const caps: string[] = [];
  alignBlocks(oldTexts, newTexts, undefined, "read", (cap) => caps.push(cap));
  assert.deepEqual(caps, ["alignment"]);
  assert.throws(() => alignBlocks(oldTexts, newTexts, undefined, "edit", (cap) => caps.push(cap)), TooLargeToMerge);
  assert.deepEqual(caps, ["alignment"]);

  // Equal ends are kept as pairs around the unpaired middle.
  const framed = alignBlocks(["head", ...oldTexts, "tail"], ["head", ...newTexts, "tail"]);
  assert.deepEqual(framed[0], { old: 0, new: 0 });
  assert.deepEqual(framed[framed.length - 1], { old: oldTexts.length + 1, new: newTexts.length + 1 });
});

test("past the pairing cap, summed over gaps split by empty paragraphs, larger gaps are left unpaired and a 1×1 gap is paired", () => {
  // Three gaps of 600 × 600 (360,000 pairs each, 1.08M in all), split by
  // shared empty paragraphs, then a 1×1 gap. Each new block is a rewrite of
  // the old one beside it, so under the cap every pair would be paired.
  const gap = (n: number) => blocks(`gap${n}`, 600);
  const rewritten = (texts: string[]) => texts.map((text) => `${text}, reworded`);
  const oldTexts = [...gap(1), "", ...gap(2), "", ...gap(3), "", "a lone block", ""];
  const newTexts = [...rewritten(gap(1)), "", ...rewritten(gap(2)), "", ...rewritten(gap(3)), "", "a lone block, reworded", ""];
  assert.ok(3 * 600 * 600 > PAIRING_MAX_PAIRS && 600 * 600 < PAIRING_MAX_PAIRS);

  const pairs = alignBlocks(oldTexts, newTexts);
  const lone = oldTexts.indexOf("a lone block");
  assert.deepEqual(pairs.find((pair) => pair.old === lone), { old: lone, new: newTexts.indexOf("a lone block, reworded") });
  const paired = pairs.filter((pair) => pair.old !== null && pair.new !== null);
  // The four empty paragraphs anchor, the lone block pairs, and nothing else does.
  assert.equal(paired.length, 5);
  assert.deepEqual(pairs.slice(0, 2), [{ old: 0, new: null }, { old: 1, new: null }]);
  assert.deepEqual(pairs[600], { old: null, new: 0 });
  assert.throws(() => alignBlocks(oldTexts, newTexts, undefined, "edit"), TooLargeToMerge);
  const caps: string[] = [];
  alignBlocks(oldTexts, newTexts, undefined, "read", (cap) => caps.push(cap));
  assert.deepEqual(caps, ["pairing"]);

  // Two such gaps are under the cap, and pair as before, with nothing told.
  const underOld = [...gap(1), "", ...gap(2)];
  const underNew = [...rewritten(gap(1)), "", ...rewritten(gap(2))];
  const under = alignBlocks(underOld, underNew, undefined, "edit");
  assert.equal(under.filter((pair) => pair.old !== null && pair.new !== null).length, underOld.length);
  alignBlocks(underOld, underNew, undefined, "read", (cap) => caps.push(cap));
  assert.deepEqual(caps, ["pairing"]);
});
