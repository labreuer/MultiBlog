import { test } from "node:test";
import assert from "node:assert/strict";
import { alignBlocks, diffRuns, renderWordDiff } from "./block-align";

// docs/MCP.md §6 — the block alignment an edit, a read of changes and a
// revert share, and the word diff within a pair.

test("identical blocks anchor, and the blocks between two anchors pair in order", () => {
  assert.deepEqual(alignBlocks(["a", "b", "c"], ["a", "B", "c"]), [
    { old: 0, new: 0 },
    { old: 1, new: 1 },
    { old: 2, new: 2 },
  ]);
  // An insertion between two changed blocks: the changed ones still pair with
  // each other, and the new one is added whole, which y-prosemirror's own
  // greedy pairing gets wrong (docs/MCP.md §6, step 3).
  assert.deepEqual(alignBlocks(["h", "p1", "p2", "t"], ["h", "p1'", "new", "p2'", "t"]), [
    { old: 0, new: 0 },
    { old: 1, new: 1 },
    { old: 2, new: 2 },
    { old: null, new: 3 },
    { old: 3, new: 4 },
  ]);
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
