import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAFT_BLOCKS_EDIT_MESSAGE, editAffordance } from "./anchored-link-editing";

// The four states an Edit affordance can be in, from the open link alone
// (docs/ANCHORED_LINKS.md, "Editing a minted link"). Pinned because three
// surfaces render off this one answer and the "blocked" arm is the whole
// reason the button exists as a visible state rather than an error after.

test("no answer yet renders nothing", () => {
  assert.deepEqual(editAffordance(undefined, "L1"), { state: "unknown" });
});

test("nothing open is ready", () => {
  assert.deepEqual(editAffordance(null, "L1"), { state: "ready" });
});

test("the link already in the tray is open-here, whatever its parts", () => {
  assert.deepEqual(editAffordance({ id: "L1", minted: true, partCount: 3 }, "L1"), { state: "open-here" });
});

test("a draft with passages blocks, and says why", () => {
  assert.deepEqual(editAffordance({ id: "D", minted: false, partCount: 1 }, "L1"), {
    state: "blocked",
    reason: DRAFT_BLOCKS_EDIT_MESSAGE,
  });
});

test("an empty draft gives way — the action discards it", () => {
  assert.deepEqual(editAffordance({ id: "D", minted: false, partCount: 0 }, "L1"), { state: "ready" });
});

test("another minted link mid-edit gives way — closing it loses nothing", () => {
  assert.deepEqual(editAffordance({ id: "L2", minted: true, partCount: 2 }, "L1"), { state: "ready" });
});
