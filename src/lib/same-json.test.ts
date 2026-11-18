import { test } from "node:test";
import assert from "node:assert/strict";
import { sameJson } from "./same-json";
import type { DiffRow } from "./doc-diff";

// What DocDiff's rows are memoized on: a row that compares equal is not
// drawn again, so a difference this misses is a stale row on the page.

const cell = (text: string, change = false, heading = false) => ({ spans: [{ text, change }], heading });

test("equal rows compare equal though nothing is shared", () => {
  const rows: DiffRow[] = [
    { kind: "same", old: cell("a"), new: cell("a") },
    { kind: "changed", old: cell("a", true), new: cell("b", true), capped: true },
    { kind: "deleted", old: cell("gone", true) },
    { kind: "added", new: cell("new", true, true) },
    { kind: "unchanged", count: 12 },
    { kind: "past-deadline" },
  ];
  for (const row of rows) assert.equal(sameJson(row, structuredClone(row)), true, row.kind);
});

test("any difference in a row is a difference", () => {
  const base: DiffRow = { kind: "changed", old: cell("a", true), new: cell("b", true) };
  const others: DiffRow[] = [
    { kind: "same", old: cell("a", true), new: cell("b", true) },
    { kind: "changed", old: cell("a", true), new: cell("c", true) },
    { kind: "changed", old: cell("a", false), new: cell("b", true) },
    { kind: "changed", old: cell("a", true), new: cell("b", true, true) },
    { kind: "changed", old: cell("a", true), new: cell("b", true), capped: true },
    { kind: "changed", old: cell("a", true), new: cell("b", true), whole: true },
    { kind: "changed", old: cell("a", true), new: { spans: [{ text: "b", change: true }, { text: "", change: false }], heading: false } },
    { kind: "changed", old: cell("a", true), new: { spans: [], heading: false } },
    { kind: "deleted", old: cell("a", true) },
  ];
  for (const other of others) {
    assert.equal(sameJson(base, other), false, JSON.stringify(other));
    assert.equal(sameJson(other, base), false, JSON.stringify(other));
  }
  assert.equal(sameJson({ kind: "unchanged", count: 2 }, { kind: "unchanged", count: 3 }), false);
});

test("primitives, null, arrays and objects are not mistaken for one another", () => {
  assert.equal(sameJson(null, null), true);
  assert.equal(sameJson(null, {}), false);
  assert.equal(sameJson({}, null), false);
  assert.equal(sameJson([], {}), false);
  assert.equal(sameJson([1, 2], [2, 1]), false);
  assert.equal(sameJson([1, 2], [1, 2, 3]), false);
  assert.equal(sameJson({ a: undefined }, { b: undefined }), false);
  assert.equal(sameJson("1", 1), false);
  assert.equal(sameJson(0, false), false);
});
