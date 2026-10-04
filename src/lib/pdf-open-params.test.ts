import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFromHash } from "./pdf-open-params";

test("#page=n is the page, with or without other parameters", () => {
  assert.equal(pageFromHash("#page=12"), 12);
  assert.equal(pageFromHash("page=3"), 3);
  assert.equal(pageFromHash("#zoom=200&page=7"), 7);
  assert.equal(pageFromHash("#page=4&zoom=page-fit"), 4);
});

test("anything else asks for no page", () => {
  for (const hash of ["", "#", "#page=", "#page=0", "#page=-1", "#page=2x", "#page=1.5", "#ada-lovelace-2026-10-04-12-00-00", "#pages=3"]) {
    assert.equal(pageFromHash(hash), null, hash);
  }
});
