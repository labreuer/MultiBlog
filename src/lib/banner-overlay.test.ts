import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOneOfs } from "./banner-overlay";

const last = (count: number) => count - 1;

test("a one-of keeps the alternative picked, each one-of picked for itself", () => {
  const html = "<p>An <!-- one-of -->engineer<!-- or --><i>sociologist</i><!-- end --> and <!--one-of-->a<!--or-->b<!--or-->c<!--end-->.</p>";
  assert.equal(resolveOneOfs(html, () => 0), "<p>An engineer and a.</p>");
  assert.equal(resolveOneOfs(html, last), "<p>An <i>sociologist</i> and c.</p>");
});

test("markup with no one-of, or one never ended, is left as written", () => {
  for (const html of ["<h1>Name</h1><!-- a note -->", "<!-- one-of -->a<!-- or -->b"]) {
    assert.equal(resolveOneOfs(html, last), html);
  }
});
