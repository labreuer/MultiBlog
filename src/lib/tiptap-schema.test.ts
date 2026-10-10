import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import BaseStarterKit from "@tiptap/starter-kit";
import {
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
