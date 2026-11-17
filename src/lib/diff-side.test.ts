import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPath, parseDiffSide, parseUpdateId, pastForkPoint, sideOrder, type PairLineage } from "./diff-side";

// docs/FORKS.md "The route" — a diff side, and what it refuses: anything but
// a doc id, or a doc id and one version within Postgres's bigint. And "Which
// side is later": which pairs have an order.

const DOC = "cmv77tijd0000gts6g0bj8vir";

test("a side is a doc id, or a doc id and a version, with Next's %40 decoded", () => {
  assert.deepEqual(parseDiffSide(DOC), { docId: DOC, updateId: null });
  assert.deepEqual(parseDiffSide(`${DOC}@1234`), { docId: DOC, updateId: BigInt("1234") });
  assert.deepEqual(parseDiffSide(`${DOC}%401234`), { docId: DOC, updateId: BigInt("1234") });
  assert.deepEqual(parseDiffSide(`${DOC}@9223372036854775807`), { docId: DOC, updateId: BigInt("9223372036854775807") });
});

test("anything else is refused, so the route answers 404 before the database is asked", () => {
  for (const bad of [
    `${DOC}@`,
    "@1234",
    `${DOC}@0`,
    `${DOC}@01`,
    `${DOC}@1@2`,
    `${DOC}@9223372036854775808`,
    `${DOC}@99999999999999999999`,
    `${DOC}@-1`,
    `${DOC}@1.5`,
    "a-slug-not-an-id",
    "Cmv77",
    "",
    "%E0%A4%A",
  ]) {
    assert.equal(parseDiffSide(bad), null, bad);
  }
  assert.equal(parseUpdateId("1"), BigInt("1"));
  assert.equal(parseUpdateId("0"), null);
  assert.equal(parseUpdateId(" 1"), null);
});

test("a diff path parses back to its sides", () => {
  const left = { docId: DOC, updateId: BigInt("42") };
  const right = { docId: "other0000doc", updateId: null };
  const path = diffPath(left, right);
  assert.equal(path, `/diff/${DOC}@42/other0000doc`);
  const [, , a, b] = path.split("/");
  assert.deepEqual(parseDiffSide(encodeURIComponent(a)), left);
  assert.deepEqual(parseDiffSide(b), right);
});

test("one doc on both sides has an order: the lower version is the earlier, and now is later than any version", () => {
  const at = (updateId: number | null, docId = DOC) => ({ docId, updateId: updateId === null ? null : BigInt(updateId) });
  assert.equal(sideOrder(at(3), at(40)), "left-earlier");
  assert.equal(sideOrder(at(40), at(3)), "right-earlier");
  assert.equal(sideOrder(at(40), at(null)), "left-earlier");
  assert.equal(sideOrder(at(null), at(40)), "right-earlier");
  // Compared as bigints: as numbers these two are equal.
  assert.equal(
    sideOrder({ docId: DOC, updateId: BigInt("9007199254740993") }, { docId: DOC, updateId: BigInt("9007199254740992") }),
    "right-earlier",
  );
});

test("a pair with no order: one version twice, now twice, or two docs", () => {
  const at = (updateId: number | null, docId = DOC) => ({ docId, updateId: updateId === null ? null : BigInt(updateId) });
  assert.equal(sideOrder(at(7), at(7)), null);
  assert.equal(sideOrder(at(null), at(null)), null);
  assert.equal(sideOrder(at(3), at(40, "other0000doc")), null);
  assert.equal(sideOrder(at(null), at(40, "other0000doc")), null);
});

// A fork and its parent: FORK was made of DOC at DOC's update 40.
const FORK = "fork0000doc";
const lineage = (parentNow: number | null = 40): PairLineage => ({
  parentDocId: DOC,
  forkDocId: FORK,
  forkPoint: BigInt(40),
  parentNow: parentNow === null ? null : BigInt(parentNow),
});
const side = (docId: string, updateId: number | null) => ({ docId, updateId: updateId === null ? null : BigInt(updateId) });

test("a fork and its parent at or before the fork point: the parent is the earlier, whichever version the fork is at", () => {
  for (const forkAt of [41, 90, null]) {
    for (const parentAt of [40, 12]) {
      assert.equal(sideOrder(side(DOC, parentAt), side(FORK, forkAt), lineage()), "left-earlier");
      assert.equal(sideOrder(side(FORK, forkAt), side(DOC, parentAt), lineage()), "right-earlier");
      assert.equal(pastForkPoint(side(DOC, parentAt), side(FORK, forkAt), lineage()), false);
    }
  }
});

test("a parent's side with no version stands at the update the parent is at now", () => {
  // Unchanged since the fork: still at the fork point.
  assert.equal(sideOrder(side(DOC, null), side(FORK, null), lineage(40)), "left-earlier");
  assert.equal(pastForkPoint(side(DOC, null), side(FORK, null), lineage(40)), false);
  // Changed since.
  assert.equal(sideOrder(side(DOC, null), side(FORK, null), lineage(77)), null);
  assert.equal(pastForkPoint(side(DOC, null), side(FORK, null), lineage(77)), true);
  // Not known: no order, and no claim that both changed.
  assert.equal(sideOrder(side(DOC, null), side(FORK, null), lineage(null)), null);
  assert.equal(pastForkPoint(side(DOC, null), side(FORK, null), lineage(null)), false);
});

test("a fork and its parent past the fork point have no order, either way round", () => {
  assert.equal(sideOrder(side(DOC, 41), side(FORK, null), lineage()), null);
  assert.equal(sideOrder(side(FORK, 90), side(DOC, 77), lineage()), null);
  assert.equal(pastForkPoint(side(DOC, 41), side(FORK, null), lineage()), true);
  assert.equal(pastForkPoint(side(FORK, 90), side(DOC, 77), lineage()), true);
});

test("lineage that isn't this pair's changes nothing, and one doc on both sides ignores it", () => {
  const other = "other0000doc";
  assert.equal(sideOrder(side(DOC, 12), side(other, null), lineage()), null);
  assert.equal(sideOrder(side(other, 12), side(FORK, null), lineage()), null);
  assert.equal(pastForkPoint(side(DOC, 77), side(other, null), lineage()), false);
  assert.equal(sideOrder(side(DOC, 77), side(DOC, 12), lineage()), "right-earlier");
  assert.equal(pastForkPoint(side(DOC, 77), side(DOC, 12), lineage()), false);
  assert.equal(pastForkPoint(side(DOC, 77), side(FORK, null), null), false);
});

test("the fork point is compared as a bigint", () => {
  const big: PairLineage = { parentDocId: DOC, forkDocId: FORK, forkPoint: BigInt("9007199254740992"), parentNow: null };
  const parentAt = { docId: DOC, updateId: BigInt("9007199254740993") };
  assert.equal(sideOrder(parentAt, side(FORK, null), big), null);
  assert.equal(pastForkPoint(parentAt, side(FORK, null), big), true);
});
