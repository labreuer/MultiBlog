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

// docs/TIPTAP.md "Inline code takes other marks" — inline code with other
// marks on all or part of it, through each Markdown exporter and back. The
// Markdown must keep every other mark's delimiters outside the backticks,
// where they mean formatting rather than text, or the round trip writes them
// into the code.

const bold = { type: "bold" };
const italic = { type: "italic" };
const strike = { type: "strike" };
const code = { type: "code" };
const link = { type: "link", attrs: { href: "https://example.com/" } };
const t = (text: string, ...marks: { type: string; attrs?: Record<string, unknown> }[]): JSONContent => ({
  type: "text",
  text,
  ...(marks.length ? { marks } : {}),
});

const cases: Record<string, JSONContent[]> = {
  "bold code": [t("Run "), t("wf_1234", bold, code), t(" first.")],
  "italic code": [t("wf_1234", italic, code)],
  "struck code": [t("wf_1234", strike, code)],
  "linked code": [t("wf_1234", link, code)],
  "code bolded at its start": [t("Run "), t("wf", bold, code), t("_1234", code), t(" first.")],
  "code italic in its middle": [t("a", code), t("b", italic, code), t("c", code)],
  "bold across code's start": [t("R"), t("un ", bold), t("wf_", bold, code), t("1234", code)],
  "code linked in part": [t("wf", link, code), t("_1234", code)],
  "bold and italic, then bold": [t("a", bold, italic, code), t("b", bold, code)],
  "bold code, then italic code": [t("a", bold, code), t("b", italic, code)],
};

const exporters: [string, Schema, (json: JSONContent) => string, (markdown: string) => JSONContent][] = [
  ["doc", pmDocContentSchema, docContentToMarkdown, (md) => ({ type: "doc", content: markdownToBlocks(md) })],
  ["comment", pmCommentContentSchema, commentContentToMarkdown, markdownToCommentContent],
  ["annotation", pmAnnotationContentSchema, annotationContentToMarkdown, markdownToAnnotationContent],
];

for (const [kind, schema, toMarkdown, fromMarkdown] of exporters) {
  test(`${kind}: inline code with other marks on all or part of it reads back as it was`, () => {
    for (const [name, content] of Object.entries(cases)) {
      const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content }] });
      const markdown = toMarkdown(doc.toJSON());
      const back = schema.nodeFromJSON(fromMarkdown(markdown));
      assert.ok(back.eq(doc), `${name}: ${JSON.stringify(markdown)} read back as ${JSON.stringify(back.toJSON())}`);
    }
  });
}

test("a split code span's other marks sit outside its backticks", () => {
  const json = { type: "doc", content: [{ type: "paragraph", content: cases["code bolded at its start"] }] };
  assert.equal(docContentToMarkdown(json), "Run **`wf`**`_1234` first.");
  // A quotation around code, in a comment: the quotes stay outside, as the matcher reads them.
  const quoted = { type: "doc", content: [{ type: "paragraph", content: [t("wf_1234", { type: "quote", attrs: { anchorId: "q1" } }, code)] }] };
  assert.equal(commentContentToMarkdown(quoted), '"`wf_1234`"');
});
