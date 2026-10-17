import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import BaseStarterKit from "@tiptap/starter-kit";
import {
  EDITOR_LINK_OPTIONS,
  StarterKit,
  pmAnnotationContentSchema,
  pmCommentContentSchema,
  pmDocContentSchema,
  pmSchema,
} from "./tiptap-schema";

// docs/TIPTAP.md "Inline code takes other marks" — the code mark every schema
// and live editor is built with, and the StarterKit that carries it.

test("in every schema, inline code excludes only itself", () => {
  for (const [name, schema] of Object.entries({ pmSchema, pmDocContentSchema, pmAnnotationContentSchema, pmCommentContentSchema })) {
    const code = schema.marks.code;
    const excluded = Object.values(schema.marks).filter((mark) => code.excludes(mark)).map((mark) => mark.name);
    assert.deepEqual(excluded, ["code"], name);
  }
});

test("code is the innermost mark with a Markdown form in every schema", () => {
  for (const [name, schema] of Object.entries({ pmSchema, pmDocContentSchema, pmAnnotationContentSchema, pmCommentContentSchema })) {
    const order = Object.keys(schema.marks);
    const before = order.slice(0, order.indexOf("code"));
    const after = order.slice(order.indexOf("code") + 1);
    assert.deepEqual(after.filter((mark) => mark !== "authorHighlight" && mark !== "annotation"), [], name);
    assert.ok(before.includes("bold") && before.includes("link"), name);
  }
});

test("StarterKit has the package's marks with code moved last, and still takes code: false", () => {
  const original = Object.keys(getSchema([BaseStarterKit]).marks);
  assert.deepEqual(Object.keys(getSchema([StarterKit]).marks), [...original.filter((mark) => mark !== "code"), "code"]);
  assert.equal(getSchema([StarterKit.configure({ code: false })]).marks.code, undefined);
});

// docs/TIPTAP.md "Autolink passes `.md` filenames by". Each value is what
// linkify hands shouldAutoLink for a match — "docs/COLLAB.md" arrives as
// "COLLAB.md", and a query is cut off — so these are its inputs as they
// really come.
test("autolink passes a scheme-less .md name by, and links everything else as before", () => {
  const { shouldAutoLink } = EDITOR_LINK_OPTIONS;
  for (const value of ["Connections.md", "COLLAB.md", "README.MD", "example.md/path", "example.md:8080"]) {
    assert.equal(shouldAutoLink(value), false, value);
  }
  for (const value of ["https://example.md", "http://foo.md/x", "www.example.md", "user@example.md"]) {
    assert.equal(shouldAutoLink(value), true, value);
  }
  // Untouched by the rule: other domains, and the default's own refusals.
  for (const value of ["example.com", "claude.ai", "notes.mdx", "md.example.com"]) {
    assert.equal(shouldAutoLink(value), true, value);
  }
  for (const value of ["192.168.0.1", "localhost"]) {
    assert.equal(shouldAutoLink(value), false, value);
  }
});
