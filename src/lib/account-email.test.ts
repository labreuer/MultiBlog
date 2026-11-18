import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlausibleEmail, normalizeAccountEmail } from "./account-email";

// docs/EMAIL.md §10, "Mistakes that fail no check": an email is stored
// trimmed, as typed, never lowercased.

test("an email is trimmed and keeps its case", () => {
  assert.equal(normalizeAccountEmail("  Foo.Bar@Example.com \n"), "Foo.Bar@Example.com");
});

test("a plausible email", () => {
  for (const ok of ["a@b", "first_last@example.com", "x+tag@sub.example.org"]) {
    assert.equal(isPlausibleEmail(ok), true, ok);
  }
  for (const bad of ["", "no-at", "@example.com", "a@", "a b@example.com", "a@b@c", `${"x".repeat(250)}@b.cc`]) {
    assert.equal(isPlausibleEmail(bad), false, bad);
  }
});
