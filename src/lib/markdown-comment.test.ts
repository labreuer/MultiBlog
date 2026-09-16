import { test } from "node:test";
import assert from "node:assert/strict";
import { commentContentToMarkdown, markdownToCommentContent } from "./markdown-import";
import { isCommentBodyError, parseCommentBody } from "./comment-body";

// PLAN.md §23m — what each piece of Markdown syntax becomes in a comment, and
// above all what the *out-of-schema* syntax becomes: the parser's own
// fallback would emit a heading node (which the schema then throws on) and
// delete fences and tables outright. Every case here also runs
// parseCommentBody, so the table doubles as proof that the conform pass emits
// only what the schema accepts.

function parse(markdown: string) {
  const json = markdownToCommentContent(markdown);
  const result = parseCommentBody(json);
  assert.ok(!isCommentBodyError(result), `refused: ${"error" in result ? result.error : ""} for ${JSON.stringify(json)}`);
  return json.content!;
}

test("inline marks, lists, blockquotes, hard breaks and links parse to schema nodes", () => {
  const blocks = parse("**b** *i* ~~s~~ `c`\n\n- one\n- two\n\n1. first\n\n> quoted\n\nline one  \nline two\n\n[x](https://a.invalid/?q=1&r=2)");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "bulletList", "orderedList", "blockquote", "paragraph", "paragraph"],
  );
  const marks = blocks[0].content!.filter((n) => n.marks).map((n) => n.marks![0].type);
  assert.deepEqual(marks, ["bold", "italic", "strike", "code"]);
  assert.equal(blocks[4].content![1].type, "hardBreak");
  const link = blocks[5].content![0].marks![0];
  assert.equal(link.type, "link");
  assert.equal(link.attrs!.href, "https://a.invalid/?q=1&r=2");
});

test("a heading becomes a bold paragraph rather than a heading node", () => {
  const blocks = parse("# Title\n\nbody");
  assert.equal(blocks[0].type, "paragraph");
  assert.deepEqual(blocks[0].content, [{ type: "text", text: "Title", marks: [{ type: "bold" }] }]);
  assert.equal(blocks[1].type, "paragraph");
});

test("a code fence becomes code-marked lines joined by hard breaks, not nothing", () => {
  const blocks = parse("before\n\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\nafter");
  assert.equal(blocks.length, 3);
  const fence = blocks[1];
  assert.equal(fence.type, "paragraph");
  assert.deepEqual(fence.content, [
    { type: "text", text: "let x = 1;", marks: [{ type: "code" }] },
    { type: "hardBreak" },
    { type: "hardBreak" },
    { type: "text", text: "let y = 2;", marks: [{ type: "code" }] },
  ]);
});

test("a table becomes its literal source, one row per line, not nothing", () => {
  const blocks = parse("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "paragraph");
  assert.deepEqual(blocks[0].content, [
    { type: "text", text: "| a | b |" },
    { type: "hardBreak" },
    { type: "text", text: "|---|---|" },
    { type: "hardBreak" },
    { type: "text", text: "| 1 | 2 |" },
  ]);
});

test("an image keeps its alt text, a rule is dropped, and raw HTML stays literal", () => {
  assert.equal(parse("see ![alt text](https://x.invalid/p.png) here")[0].content![0].text, "see alt text here");
  assert.deepEqual(
    parse("one\n\n---\n\ntwo").map((b) => b.content![0].text),
    ["one", "two"],
  );
  const html = parse("<script>alert(1)</script> and <b>bold</b>");
  assert.equal(html[0].content![0].text, "<script>alert(1)</script> and <b>bold</b>");
  assert.equal(html[0].content![0].marks, undefined);
});

test("a soft line break becomes a space, not a newline inside the text node", () => {
  assert.equal(parse("line one\nline two")[0].content![0].text, "line one line two");
});

test("entities are decoded outside code and left alone inside it", () => {
  const blocks = parse("caf&eacute; and `&lt;div&gt;`");
  assert.equal(blocks[0].content![0].text, "café and ");
  assert.equal(blocks[0].content![1].text, "&lt;div&gt;");
});

test("an empty source yields one empty paragraph, which the write path then refuses", () => {
  const json = markdownToCommentContent("   \n");
  assert.deepEqual(json, { type: "doc", content: [{ type: "paragraph" }] });
  assert.ok(isCommentBodyError(parseCommentBody(json)));
});

test("a deep blockquote parses and is refused by the depth cap, never by a throw", () => {
  const json = markdownToCommentContent("> > > > > > > > deep");
  const result = parseCommentBody(json);
  assert.ok(isCommentBodyError(result));
  assert.match(result.error, /deeply/);
});

test("serializing back to Markdown re-parses to the same document", () => {
  const source = "**bold** and *italic*\n\n> a quote\n\n- one\n- two\n\n[x](https://a.invalid/)";
  const json = markdownToCommentContent(source);
  const roundTripped = markdownToCommentContent(commentContentToMarkdown(json));
  assert.deepEqual(roundTripped, json);
});
