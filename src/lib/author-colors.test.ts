import { test } from "node:test";
import assert from "node:assert/strict";
import { onAuthorColor } from "./author-colors";

// The threshold's contract, pinned at its edges and at the two colors the
// choice was calibrated on (author-colors.ts's comment): the house default
// blue keeps white initials, a real near-white pick gets black ones.
test("onAuthorColor picks white on dark fills", () => {
  assert.equal(onAuthorColor("#000000"), "#ffffff");
  assert.equal(onAuthorColor("#5b8cff"), "#ffffff"); // User.color schema default
  assert.equal(onAuthorColor("#845ef7"), "#ffffff"); // palette purple
});

test("onAuthorColor picks black on light fills", () => {
  assert.equal(onAuthorColor("#ffffff"), "#000000");
  assert.equal(onAuthorColor("#6bffe6"), "#000000"); // the near-white that motivated this
  assert.equal(onAuthorColor("#fab005"), "#000000"); // palette yellow
});

test("onAuthorColor falls back to white on unrecognized input", () => {
  assert.equal(onAuthorColor(""), "#ffffff");
  assert.equal(onAuthorColor("#fff"), "#ffffff");
  assert.equal(onAuthorColor("rebeccapurple"), "#ffffff");
});
