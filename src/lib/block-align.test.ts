import { test } from "node:test";
import assert from "node:assert/strict";
import { alignBlocks, diffRuns, renderWordDiff } from "./block-align";

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
