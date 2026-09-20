import assert from "node:assert/strict";
import { test } from "node:test";
import { SCRUB_PARAM, parseScrubUpdateId, scrubHref, scrubUrl } from "./scrub-url";

// The parameter is attacker-supplied by definition — it is a URL people paste
// at each other — and its rejection surface is the whole reason this is a
// function rather than three lines in page.tsx. A rejected value means "no
// scrub position", never an error: the reading view renders live, exactly as
// if nothing had been asked for.

test("a well-formed ydoc_update id survives", () => {
  assert.equal(parseScrubUpdateId("1"), "1");
  assert.equal(parseScrubUpdateId("42"), "42");
  // 19 digits — a bigint identity column's ceiling, and comfortably past
  // Number.MAX_SAFE_INTEGER, which is why this stays a string end to end.
  assert.equal(parseScrubUpdateId("9223372036854775807"), "9223372036854775807");
});

test("anything that isn't a bare positive integer is no position at all", () => {
  for (const value of [
    undefined,
    null,
    "",
    " ",
    " 12",
    "12 ",
    "0", // identity columns start at 1, so this names nothing
    "007", // one canonical spelling per position, so no leading zeros
    "-1",
    "+1",
    "1.0",
    "1e3",
    "0x10",
    "12,13",
    "abc",
    "1'; drop table ydoc_update; --",
    "99999999999999999999", // 20 digits: past a bigint
  ]) {
    assert.equal(parseScrubUpdateId(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test("a repeated parameter arrives as an array and is rejected", () => {
  // Next hands a page `?at=1&at=2` as `["1", "2"]` whatever the narrowed
  // searchParams type claims, so the runtime check is not redundant with TS.
  assert.equal(parseScrubUpdateId(["1", "2"] as unknown as string), null);
});

test("scrubUrl sets the position and returns a path-relative URL", () => {
  assert.equal(scrubUrl("https://example.test/doc/my-doc", "7"), "/doc/my-doc?at=7");
  assert.equal(scrubUrl("https://example.test/doc/my-doc?at=3", "7"), "/doc/my-doc?at=7");
});

test("the live end is the absence of the parameter", () => {
  assert.equal(scrubUrl("https://example.test/doc/my-doc?at=7", null), "/doc/my-doc");
  assert.equal(scrubUrl("https://example.test/doc/my-doc", null), "/doc/my-doc");
});

test("every other parameter and the hash survive, in place", () => {
  // ?sel= is an anchored link's whole meaning on this route, and the fragment
  // is which annotation the reader followed a link to — dropping either while
  // rewriting an unrelated parameter is the failure this pins down.
  assert.equal(
    scrubUrl("https://example.test/doc/my-doc?sel=abc#annotation-x", "7"),
    "/doc/my-doc?sel=abc&at=7#annotation-x",
  );
  assert.equal(
    scrubUrl("https://example.test/doc/my-doc?sel=abc&at=7#annotation-x", null),
    "/doc/my-doc?sel=abc#annotation-x",
  );
  // Set in place rather than moved to the end, so a URL rewritten on every
  // settled position doesn't shuffle its own parameters as the reader drags.
  assert.equal(scrubUrl("https://example.test/doc/d?at=1&sel=abc", "9"), "/doc/d?at=9&sel=abc");
});

test("the parameter name is the one the page reads", () => {
  assert.equal(SCRUB_PARAM, "at");
  assert.ok(scrubUrl("https://example.test/doc/d", "5").includes(`${SCRUB_PARAM}=5`));
});

test("scrubHref links to a revision, with the fragment the caller named", () => {
  assert.equal(scrubHref("/doc/my-doc", "7"), "/doc/my-doc?at=7");
  assert.equal(scrubHref("/doc/my-doc", "7", "ada-2026-09-20-11-30-00"), "/doc/my-doc?at=7#ada-2026-09-20-11-30-00");
});

test("scrubHref carries the position and the fragment, and nothing else", () => {
  // It takes a pathname, so there is no way for it to pick up the copier's
  // own ?sel= — which would send the recipient to a different subject.
  assert.ok(!scrubHref("/doc/my-doc", "7", "anchor").includes("sel"));
});
