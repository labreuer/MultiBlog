import { test } from "node:test";
import assert from "node:assert/strict";
import { sideAtPosition, sideUpdate, sliderPosition, type VersionIndex } from "./diff-slider";

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
