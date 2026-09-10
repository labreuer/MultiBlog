import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK_NAME_MAX_LENGTH, UNNAMED_LINK_TITLE, anchoredLinkTitle, normalizeLinkName } from "./anchored-link-name";

// The rejection surface of a link's name (docs/ANCHORED_LINKS.md, "Naming a
// link"): what the writer stores is null or a name, never a blank — the
// database CHECK says the same, and this pins the function that keeps the
// two from ever disagreeing.

test("nothing, or only whitespace, is null — never an empty string", () => {
  assert.equal(normalizeLinkName(""), null);
  assert.equal(normalizeLinkName("   "), null);
  assert.equal(normalizeLinkName("\n\t "), null);
});

test("surrounding whitespace goes and internal runs collapse to one space", () => {
  assert.equal(normalizeLinkName("  Smith  on\n retries "), "Smith on retries");
});

test("the cap applies after collapsing, and never leaves a trailing space", () => {
  const long = "a ".repeat(LINK_NAME_MAX_LENGTH);
  const name = normalizeLinkName(long)!;
  assert.ok(name.length <= LINK_NAME_MAX_LENGTH);
  assert.equal(name, name.trim());
  assert.equal(normalizeLinkName("x".repeat(200))!.length, LINK_NAME_MAX_LENGTH);
});

test("a title is the name, or the generic one when there is none", () => {
  assert.equal(anchoredLinkTitle("Retries, both readings"), "Retries, both readings");
  assert.equal(anchoredLinkTitle(null), UNNAMED_LINK_TITLE);
  assert.equal(anchoredLinkTitle(undefined), UNNAMED_LINK_TITLE);
});
