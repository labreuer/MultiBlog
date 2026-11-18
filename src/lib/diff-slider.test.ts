import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assemblePair,
  isDiffPairRead,
  planPair,
  sideAtPosition,
  sideUpdate,
  sliderPosition,
  type BuiltSide,
  type DiffPairRead,
  type DiffSideRead,
  type VersionIndex,
} from "./diff-slider";

const at = (id: string) => ({ id, createdAt: "2026-11-17T00:00:00.000Z" });
const INDEX: VersionIndex = [at("10"), at("11"), at("15"), at("20")];

test("a side at a version sits on that update", () => {
  assert.equal(sliderPosition(INDEX, { updateId: "10", readAt: null }), 0);
  assert.equal(sliderPosition(INDEX, { updateId: "15", readAt: null }), 2);
  // The last id is the last position, where a side with no version sits too.
  assert.equal(sliderPosition(INDEX, { updateId: "20", readAt: null }), 3);
});

test("a side with no version sits at the live end", () => {
  assert.equal(sliderPosition(INDEX, { updateId: null, readAt: "20" }), 3);
  // Read before the index was fetched: still the live end.
  assert.equal(sliderPosition(INDEX, { updateId: null, readAt: "15" }), 3);
  // A read that gave no update.
  assert.equal(sliderPosition(INDEX, { updateId: null, readAt: null }), 3);
});

test("an index that doesn't hold the side's update is behind", () => {
  assert.equal(sliderPosition(INDEX, { updateId: "21", readAt: null }), "behind");
  // An id inside the index's range that isn't this doc's.
  assert.equal(sliderPosition(INDEX, { updateId: "12", readAt: null }), "behind");
  assert.equal(sliderPosition(INDEX, { updateId: null, readAt: "21" }), "behind");
  // Ids are compared as numbers, not as text.
  assert.equal(sliderPosition([at("9"), at("100")], { updateId: null, readAt: "20" }), 1);
  assert.equal(sliderPosition([at("9"), at("10")], { updateId: null, readAt: "9223372036854775807" }), "behind");
});

test("a doc with no log has no slider", () => {
  assert.equal(sliderPosition([], { updateId: null, readAt: null }), null);
  assert.equal(sliderPosition([], { updateId: "10", readAt: null }), null);
});

test("the last position is a side with no version, and every other names its update", () => {
  assert.deepEqual(sideAtPosition("doc", INDEX, 0), { docId: "doc", updateId: BigInt(10) });
  assert.deepEqual(sideAtPosition("doc", INDEX, 2), { docId: "doc", updateId: BigInt(15) });
  assert.deepEqual(sideAtPosition("doc", INDEX, 3), { docId: "doc", updateId: null });
  assert.deepEqual(sideAtPosition("doc", [at("10")], 0), { docId: "doc", updateId: null });
});

test("the update a side is at", () => {
  assert.equal(sideUpdate({ updateId: "15", readAt: null }), "15");
  assert.equal(sideUpdate({ updateId: null, readAt: "20" }), "20");
  assert.equal(sideUpdate({ updateId: null, readAt: null }), null);
});

// --- a pair put together without the server --------------------------------

const BLOCKS = [{ text: "As read.", type: "paragraph", heading: false }];
const read = (docId: string, updateId: string | null, over: Partial<DiffSideRead> = {}): DiffSideRead => ({
  docId,
  updateId,
  path: `/doc/${docId}-slug`,
  title: `${docId} as read`,
  headedByName: false,
  history: true,
  at: updateId === null ? null : "2026-11-17T00:00:00.000Z",
  nowVersion: updateId === null ? "20" : null,
  blocks: BLOCKS,
  ...over,
});
const pairRead = (left: DiffSideRead, right: DiffSideRead, over: Partial<DiffPairRead> = {}): DiffPairRead => ({
  readAt: "2026-11-17T12:00:00.000Z",
  order: null,
  diverged: false,
  fork: null,
  left,
  right,
  ...over,
});
const side = (docId: string, updateId: number | null) => ({ docId, updateId: updateId === null ? null : BigInt(updateId) });
const BUILT: BuiltSide = { title: "As built", at: "2026-11-16T00:00:00.000Z", blocks: [{ text: "As built.", type: "paragraph", heading: false }] };

test("a side the page shows is kept, and a side moved to a version is built", () => {
  const shown = pairRead(read("a", "10"), read("a", null));
  assert.deepEqual(planPair(shown, { left: side("a", 10), right: side("a", null) }), { left: "keep", right: "keep" });
  assert.deepEqual(planPair(shown, { left: side("a", 11), right: side("a", null) }), { left: "build", right: "keep" });
  // Off the live end, to a version.
  assert.deepEqual(planPair(shown, { left: side("a", 10), right: side("a", 15) }), { left: "keep", right: "build" });
  assert.deepEqual(planPair(shown, { left: side("a", 11), right: side("a", 15) }), { left: "build", right: "build" });
});

test("the server reads a pair with a side moved to the live end, of another doc, without the history, or that it couldn't read", () => {
  const shown = pairRead(read("a", "10"), read("b", "15"));
  // The live end is the doc as it is when next read.
  assert.equal(planPair(shown, { left: side("a", null), right: side("b", 15) }), null);
  // No slider changes a side's doc: an address has.
  assert.equal(planPair(shown, { left: side("b", 15), right: side("a", 10) }), null);
  assert.equal(planPair(shown, { left: side("c", 10), right: side("b", 15) }), null);
  // A version of a doc whose history isn't the viewer's.
  const withoutHistory = pairRead(read("a", "10"), read("b", "15", { history: false }));
  assert.deepEqual(planPair(withoutHistory, { left: side("a", 11), right: side("b", 15) }), { left: "build", right: "keep" });
  assert.equal(planPair(withoutHistory, { left: side("a", 10), right: side("b", 16) }), null);
  // A side shown without its text is not kept, though it hasn't moved.
  const unread = pairRead(read("a", "10"), read("b", "15", { blocks: null }));
  assert.equal(planPair(unread, { left: side("a", 11), right: side("b", 15) }), null);
});

test("a built side takes the page's facts about its doc and the build's about its version", () => {
  const shown = pairRead(read("a", "10"), read("a", null), { order: "left-earlier" });
  const pair = assemblePair(shown, { left: side("a", 11), right: side("a", null) }, { left: BUILT });
  assert.deepEqual(pair.left, {
    docId: "a",
    updateId: "11",
    path: "/doc/a-slug",
    title: "As built",
    headedByName: false,
    history: true,
    at: BUILT.at,
    nowVersion: null,
    blocks: BUILT.blocks,
  });
  // The kept side is the read on the page, and the pair's time is still that read's.
  assert.equal(pair.right, shown.right);
  assert.equal(pair.readAt, shown.readAt);
  assert.equal(isDiffPairRead(pair), true);
});

test("a wiki page's side built in the browser keeps its name and its address", () => {
  const named = read("a", "10", { path: "/wiki/commons/Mercury_(planet)", title: "Mercury (planet)", headedByName: true });
  const shown = pairRead(named, read("a", null), { order: "left-earlier" });
  const pair = assemblePair(shown, { left: side("a", 11), right: side("a", null) }, { left: BUILT });
  assert.equal(pair.left.title, "Mercury (planet)");
  assert.equal(pair.left.path, "/wiki/commons/Mercury_(planet)");
  assert.equal(pair.left.headedByName, true);
  assert.equal(pair.left.blocks, BUILT.blocks);
  assert.equal(isDiffPairRead(pair), true);
});

test("one doc at two versions has the order its versions give", () => {
  const shown = pairRead(read("a", "10"), read("a", null), { order: "left-earlier" });
  const order = (left: number | null, right: number | null) =>
    assemblePair(shown, { left: side("a", left), right: side("a", right) }, { left: BUILT, right: BUILT }).order;
  assert.equal(order(11, null), "left-earlier");
  assert.equal(order(11, 15), "left-earlier");
  assert.equal(order(15, 11), "right-earlier");
  assert.equal(order(11, 11), null);
});

test("a fork and its parent are placed against the fork point when the parent's side is at a version", () => {
  const fork = { parentDocId: "parent", forkDocId: "fork", forkPoint: "12" };
  // As the server read it: the parent now, past the fork point.
  const shown = pairRead(read("parent", null), read("fork", null), { fork, order: null, diverged: true });
  const place = (left: ReturnType<typeof side>, right: ReturnType<typeof side>, from = shown) => {
    const { order, diverged } = assemblePair(from, { left, right }, {});
    return { order, diverged };
  };
  assert.deepEqual(place(side("parent", 12), side("fork", null)), { order: "left-earlier", diverged: false });
  assert.deepEqual(place(side("parent", 5), side("fork", 30)), { order: "left-earlier", diverged: false });
  assert.deepEqual(place(side("parent", 13), side("fork", null)), { order: null, diverged: true });
  // The parent on the right.
  const swapped = pairRead(read("fork", null), read("parent", null), { fork, order: null, diverged: true });
  assert.deepEqual(place(side("fork", 30), side("parent", 12), swapped), { order: "right-earlier", diverged: false });
  // The parent's side kept at the live end: the fork's side moving changes nothing.
  assert.deepEqual(place(side("parent", null), side("fork", 30)), { order: null, diverged: true });
  const before = pairRead(read("parent", null), read("fork", null), { fork, order: "left-earlier", diverged: false });
  assert.deepEqual(place(side("parent", null), side("fork", 30), before), { order: "left-earlier", diverged: false });
});

test("a pair sent no fork point keeps the order on the page", () => {
  // A fork's editor without the parent's history: the parent's side can't move.
  const shown = pairRead(read("parent", "12", { history: false }), read("fork", null), { order: "left-earlier" });
  const pair = assemblePair(shown, { left: side("parent", 12), right: side("fork", 30) }, { right: BUILT });
  assert.equal(pair.order, "left-earlier");
  assert.equal(pair.diverged, false);
  // Two docs neither of which is the other's parent.
  const unrelated = pairRead(read("a", "10"), read("b", "15"));
  assert.equal(assemblePair(unrelated, { left: side("a", 11), right: side("b", 16) }, { left: BUILT, right: BUILT }).order, null);
});

test("a pair's body is told from anything else by its shape, its fork point included", () => {
  const pair = pairRead(read("a", "10"), read("b", null));
  assert.equal(isDiffPairRead(pair), true);
  assert.equal(isDiffPairRead({ ...pair, fork: { parentDocId: "a", forkDocId: "b", forkPoint: "12" } }), true);
  assert.equal(isDiffPairRead({ ...pair, fork: { parentDocId: "a" } }), false);
  assert.equal(isDiffPairRead({ ...pair, fork: undefined }), false);
  assert.equal(isDiffPairRead({ ...pair, left: { ...pair.left, blocks: "none" } }), false);
  assert.equal(isDiffPairRead({ ...pair, left: { ...pair.left, path: undefined, slug: "a-slug" } }), false);
  assert.equal(isDiffPairRead({ ...pair, left: { ...pair.left, headedByName: undefined } }), false);
});
