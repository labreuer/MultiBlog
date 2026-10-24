import { test } from "node:test";
import assert from "node:assert/strict";
import { POSTS_PER_PAGE, parsePageParam, postPageCount, postPagePath } from "./post-pages";

test("parsePageParam takes a positive integer as written", () => {
  assert.equal(parsePageParam("1"), 1);
  assert.equal(parsePageParam("2"), 2);
  assert.equal(parsePageParam("10"), 10);
  assert.equal(parsePageParam("999999"), 999999);
});

test("parsePageParam refuses anything else", () => {
  for (const raw of ["", "0", "01", "-2", "+2", "2.5", "2e1", " 2", "2 ", "abc", "0x2", "1000000"]) {
    assert.equal(parsePageParam(raw), null, JSON.stringify(raw));
  }
});

test("postPageCount rounds up, and is never below one", () => {
  assert.equal(postPageCount(0), 1);
  assert.equal(postPageCount(1), 1);
  assert.equal(postPageCount(POSTS_PER_PAGE), 1);
  assert.equal(postPageCount(POSTS_PER_PAGE + 1), 2);
  assert.equal(postPageCount(3 * POSTS_PER_PAGE), 3);
});

test("postPagePath sends page 1 to the landing page", () => {
  assert.equal(postPagePath(1), "/");
  assert.equal(postPagePath(2), "/page/2");
});
