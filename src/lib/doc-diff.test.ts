import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, hasChanges, type DiffBlock } from "./doc-diff";
import { ALIGNMENT_MAX_CELLS } from "./block-align";
import { WORD_DIFF_MAX_CELLS } from "./diff-text";

// docs/FORKS.md "What is compared" — the diff page's rows: what is shown,
// what is left out, and what is folded away. And "Where the comparing is
// done": what a row says when a size cap bit or the deadline passed.

const p = (text: string): DiffBlock => ({ text, type: "paragraph", heading: false });
const h = (text: string): DiffBlock => ({ text, type: "heading", heading: true });
const rule: DiffBlock = { text: "", type: "horizontalRule", heading: false };

test("a changed block is split into what each side lost and gained", () => {
  const rows = diffRows([p("the quick brown fox")], [p("the slow red fox")]);
  assert.deepEqual(rows, [
    {
      kind: "changed",
      old: { heading: false, spans: [{ text: "the ", change: false }, { text: "quick brown", change: true }, { text: " fox", change: false }] },
      new: { heading: false, spans: [{ text: "the ", change: false }, { text: "slow red", change: true }, { text: " fox", change: false }] },
    },
  ]);
});

test("a paragraph that became a heading with other words keeps each side's own styling", () => {
  const [row] = diffRows([p("An opening line")], [h("An opening")]);
  assert.equal(row.kind, "changed");
  assert.ok(row.kind === "changed" && !row.old.heading && row.new.heading);
});

test("an empty paragraph added or deleted is left out, and any other block without text is shown", () => {
  // TrailingNode's paragraph after a doc that ends in a heading.
  assert.equal(hasChanges(diffRows([p("Intro"), h("End")], [p("Intro"), h("End"), p("")])), false);
  assert.equal(hasChanges(diffRows([p("Intro"), p("")], [p("Intro")])), false);
  assert.deepEqual(
    diffRows([p("Intro")], [p("Intro"), rule]).filter((row) => row.kind !== "same"),
    [{ kind: "added", new: { spans: [], heading: false } }],
  );
});

test("unchanged blocks away from a change are folded, one stretch to a row, and a single one is kept", () => {
  const old = ["a", "b", "c", "d", "e", "f"].map(p);
  const rows = diffRows(old, [...old.slice(0, 4), p("E"), old[5]]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["unchanged", "same", "changed", "same"],
  );
  assert.deepEqual(rows[0], { kind: "unchanged", count: 3 });
  // Two blocks before the change: one is context, the other a stretch of one, kept.
  assert.deepEqual(
    diffRows(["a", "b", "c"].map(p), ["a", "b", "C"].map(p)).map((row) => row.kind),
    ["same", "same", "changed"],
  );
  // With no context kept, the stretch folds up to the change itself.
  assert.deepEqual(diffRows(old, [...old.slice(0, 4), p("E"), old[5]], { context: 0 }), [
    { kind: "unchanged", count: 4 },
    rows[2],
    rows[3],
  ]);
});

test("two sides with no change are one folded stretch, and two empty docs are nothing", () => {
  const rows = diffRows(["a", "b", "c"].map(p), ["a", "b", "c"].map(p));
  assert.deepEqual(rows, [{ kind: "unchanged", count: 3 }]);
  assert.equal(hasChanges(rows), false);
  assert.deepEqual(diffRows([], []), []);
});

/** `count` distinct words, `w0 w1 …`, the first and last replaced when given. */
function words(count: number, ends: { first?: string; last?: string } = {}): string {
  const list = Array.from({ length: count }, (_, i) => `w${i}`);
  if (ends.first) list[0] = ends.first;
  if (ends.last) list[count - 1] = ends.last;
  return list.join(" ");
}

test("a pair past the word diff's cap is one row that says so, its changed middle shown whole", () => {
  // ~4,200 tokens a side with a change at each end: nothing to trim, 17M cells.
  const old = words(2100);
  const next = words(2100, { first: "start", last: "end" });
  assert.ok(2 * 2100 * 2 * 2100 > WORD_DIFF_MAX_CELLS);
  const caps: string[] = [];
  const rows = diffRows(
    [p("Intro"), p(`alpha ${old} omega`), p("a small change here")],
    [p("Intro"), p(`alpha ${next} omega`), p("a small change there")],
    { onCap: (cap) => caps.push(cap) },
  );
  assert.deepEqual(rows[1], {
    kind: "changed",
    capped: true,
    old: { heading: false, spans: [{ text: "alpha ", change: false }, { text: old, change: true }, { text: " omega", change: false }] },
    new: { heading: false, spans: [{ text: "alpha ", change: false }, { text: next, change: true }, { text: " omega", change: false }] },
  });
  // The row after it is diffed as any other, and isn't marked.
  assert.ok(rows[2].kind === "changed" && !("capped" in rows[2]));
  assert.deepEqual(caps, ["word-diff"]);
});

test("a diff past the alignment's cap tells its caller, and shows the middle removed and added", () => {
  const side = (name: string) => Array.from({ length: 5001 }, (_, i) => p(`${name} block ${i}`));
  assert.ok(5001 * 5001 > ALIGNMENT_MAX_CELLS);
  const caps: string[] = [];
  const rows = diffRows([p("Intro"), ...side("old")], [p("Intro"), ...side("new")], { onCap: (cap) => caps.push(cap) });
  assert.deepEqual(caps, ["alignment"]);
  assert.equal(rows.filter((row) => row.kind === "deleted").length, 5001);
  assert.equal(rows.filter((row) => row.kind === "added").length, 5001);
  assert.equal(rows.filter((row) => row.kind === "changed").length, 0);
});

test("past the deadline the remaining changed pairs are shown whole, after a row that says where", () => {
  const old = [p("one fine day"), p("same"), p("two fine days"), p("same too"), p("three fine days")];
  const next = [p("one fine night"), p("same"), p("two fine nights"), p("same too"), p("three fine nights")];
  // A clock that ticks once each time it is read: the call, then each changed pair.
  const clock = () => {
    let t = 0;
    return () => t++;
  };
  const kinds = (ms: number) => diffRows(old, next, { deadline: { ms, now: clock() } }).map((row) => row.kind);

  // Read at the call (0), then before each changed pair (1, 2, 3).
  assert.deepEqual(kinds(4), ["changed", "same", "changed", "same", "changed"]);
  assert.deepEqual(kinds(2), ["changed", "same", "past-deadline", "changed", "same", "changed"]);
  assert.deepEqual(kinds(1), ["past-deadline", "changed", "same", "changed", "same", "changed"]);

  const rows = diffRows(old, next, { deadline: { ms: 2, now: clock() } });
  assert.deepEqual(rows[0], {
    kind: "changed",
    old: { heading: false, spans: [{ text: "one fine ", change: false }, { text: "day", change: true }] },
    new: { heading: false, spans: [{ text: "one fine ", change: false }, { text: "night", change: true }] },
  });
  assert.deepEqual(rows[3], {
    kind: "changed",
    whole: true,
    old: { heading: false, spans: [{ text: "two fine days", change: true }] },
    new: { heading: false, spans: [{ text: "two fine nights", change: true }] },
  });
  assert.equal(hasChanges(rows), true);
});

test("a deadline that passes after the last changed pair leaves no mark", () => {
  let t = 0;
  const rows = diffRows([p("a b"), p("same")], [p("a c"), p("same")], { deadline: { ms: 2, now: () => t++ } });
  assert.deepEqual(rows.map((row) => row.kind), ["changed", "same"]);
});
