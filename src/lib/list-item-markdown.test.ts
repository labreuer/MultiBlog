import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import {
  annotationContentToMarkdown,
  commentContentToMarkdown,
  docContentToMarkdown,
  markdownToAnnotationContent,
  markdownToBlocks,
  markdownToCommentContent,
} from "./markdown-import";
import { pmAnnotationContentSchema, pmCommentContentSchema, pmDocContentSchema } from "./tiptap-schema";

// list-item-markdown.ts — an empty list item, wherever it is, reads back as
// one, through each of the three Markdown managers.

const empty: JSONContent = { type: "paragraph" };
const para = (value: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const item = (...blocks: JSONContent[]): JSONContent => ({ type: "listItem", content: blocks });
const bullets = (...items: JSONContent[]): JSONContent => ({ type: "bulletList", content: items });
const numbers = (...items: JSONContent[]): JSONContent => ({ type: "orderedList", attrs: { start: 1 }, content: items });

const cases: [string, JSONContent[]][] = [
  ["a list of one empty bullet", [bullets(item(empty))]],
  ["an empty first bullet after a paragraph", [para("before"), bullets(item(empty), item(para("b")))]],
  ["an empty bullet in the middle", [bullets(item(para("a")), item(empty), item(para("c")))]],
  ["an empty last bullet", [bullets(item(para("a")), item(empty))]],
  ["two empty bullets", [bullets(item(empty), item(empty))]],
  ["an empty bullet before a paragraph", [bullets(item(empty)), para("after")]],
  ["a nested list opening with an empty bullet", [bullets(item(para("a"), bullets(item(empty), item(para("b")))))]],
  ["the same three deep", [bullets(item(para("a"), bullets(item(para("b"), bullets(item(empty))))))]],
  ["the same under a number", [numbers(item(para("a"), bullets(item(empty))))]],
  ["an empty number in the middle", [numbers(item(para("a")), item(empty), item(para("c")))]],
  ["an empty number under a bullet", [bullets(item(para("a"), numbers(item(empty), item(para("b")))))]],
  ["an empty bullet in a quote", [{ type: "blockquote", content: [bullets(item(para("a")), item(empty))] }]],
];

const managers: [string, Schema, (json: JSONContent) => string, (markdown: string) => JSONContent][] = [
  ["doc", pmDocContentSchema, docContentToMarkdown, (markdown) => ({ type: "doc", content: markdownToBlocks(markdown) })],
  ["comment", pmCommentContentSchema, commentContentToMarkdown, markdownToCommentContent],
  ["annotation", pmAnnotationContentSchema, annotationContentToMarkdown, markdownToAnnotationContent],
];

for (const [kind, schema, toMarkdown, fromMarkdown] of managers) {
  test(`${kind}: an empty list item reads back as one`, () => {
    for (const [name, blocks] of cases) {
      const doc = schema.nodeFromJSON({ type: "doc", content: blocks });
      const markdown = toMarkdown(doc.toJSON());
      const back = schema.nodeFromJSON(fromMarkdown(markdown));
      assert.ok(back.eq(doc), `${name}: ${JSON.stringify(markdown)} read back as ${JSON.stringify(back.toJSON())}`);
    }
  });
}

test("an empty bullet is its bare marker, and a list opening with one under text has a blank line above it", () => {
  assert.equal(docContentToMarkdown({ type: "doc", content: [bullets(item(para("a")), item(empty))] }), "- a\n-");
  assert.equal(docContentToMarkdown({ type: "doc", content: [bullets(item(para("a"), bullets(item(empty))))] }), "- a\n\n  -");
  // A number keeps its space, which the ordered tokenizer reads as an empty item.
  assert.equal(docContentToMarkdown({ type: "doc", content: [numbers(item(para("a")), item(empty))] }), "1. a\n2. ");
});
