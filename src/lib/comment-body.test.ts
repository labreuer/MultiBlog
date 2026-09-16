import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commentBodyText,
  commentBodyTextFromJSON,
  commentDocDepth,
  commentDocFromText,
  hardenCommentLinks,
  isCommentBodyError,
  MAX_COMMENT_CHARS,
  MAX_COMMENT_DEPTH,
  parseCommentBody,
} from "./comment-body";
import { COMMENT_LINK_REL, COMMENT_LINK_TARGET, pmCommentContentSchema } from "./tiptap-schema";

// PLAN.md §23b — the rejection surface of the comment write path, which is
// the one kind of thing test:unit is for. What the schema throws on, what the
// caps refuse, and what link hardening rewrites.

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: object[]) => ({ type: "doc", content });

test("a plain paragraph validates and round-trips to canonical JSON", () => {
  const result = parseCommentBody(doc(para("hello")));
  assert.ok(!isCommentBodyError(result));
  assert.equal(result.text, "hello");
  assert.deepEqual(result.json, doc(para("hello")));
});

test("a heading is refused — the schema is the validation", () => {
  const result = parseCommentBody(doc({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "no" }] }));
  assert.ok(isCommentBodyError(result));
  assert.match(result.error, /formatting/);
});

test("an image is refused, and so is an unknown mark", () => {
  assert.ok(isCommentBodyError(parseCommentBody(doc({ type: "image", attrs: { src: "https://x.invalid/p.png" } }))));
  assert.ok(
    isCommentBodyError(
      parseCommentBody(doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "underline" }] }] })),
    ),
  );
});

test("a tree the content expressions don't allow is refused by node.check()", () => {
  // A paragraph directly inside a paragraph builds as nodes but is not valid content.
  const result = parseCommentBody(doc({ type: "paragraph", content: [para("nested")] }));
  assert.ok(isCommentBodyError(result));
});

test("not a doc at all, and non-objects, are malformed rather than thrown", () => {
  assert.ok(isCommentBodyError(parseCommentBody(null)));
  assert.ok(isCommentBodyError(parseCommentBody("text")));
  assert.ok(isCommentBodyError(parseCommentBody({ type: "paragraph" })));
});

test("empty and whitespace-only bodies are refused", () => {
  assert.ok(isCommentBodyError(parseCommentBody(doc({ type: "paragraph" }))));
  assert.ok(isCommentBodyError(parseCommentBody(doc(para("   ")))));
});

test("the text cap is on the plain text, not the JSON", () => {
  const ok = parseCommentBody(doc(para("x".repeat(MAX_COMMENT_CHARS))));
  assert.ok(!isCommentBodyError(ok));
  const over = parseCommentBody(doc(para("x".repeat(MAX_COMMENT_CHARS + 1))));
  assert.ok(isCommentBodyError(over));
  assert.match(over.error, /too long/);
});

test("nesting deeper than MAX_COMMENT_DEPTH is refused before the schema sees it", () => {
  let inner: object = para("deep");
  for (let i = 0; i < MAX_COMMENT_DEPTH; i++) inner = { type: "blockquote", content: [inner] };
  const result = parseCommentBody(doc(inner));
  assert.ok(isCommentBodyError(result));
  assert.match(result.error, /deeply/);
  assert.equal(commentDocDepth(doc(para("x"))), 3);
});

test("links get rel and target on the stored mark, whatever the client sent", () => {
  const input = doc({
    type: "paragraph",
    content: [{ type: "text", text: "here", marks: [{ type: "link", attrs: { href: "https://a.invalid/", rel: "dofollow", target: "_self" } }] }],
  });
  const result = parseCommentBody(input);
  assert.ok(!isCommentBodyError(result));
  const mark = result.json.content![0].content![0].marks![0];
  assert.equal(mark.attrs!.href, "https://a.invalid/");
  assert.equal(mark.attrs!.rel, COMMENT_LINK_REL);
  assert.equal(mark.attrs!.target, COMMENT_LINK_TARGET);
});

test("a javascript: or relative href drops the link and keeps the text", () => {
  for (const href of ["javascript:alert(1)", "/relative", "data:text/html,hi", "", "ftp://x.invalid/"]) {
    const hardened = hardenCommentLinks(doc({ type: "paragraph", content: [{ type: "text", text: "t", marks: [{ type: "link", attrs: { href } }] }] }));
    const textNode = hardened.content![0].content![0];
    assert.equal(textNode.text, "t");
    assert.equal(textNode.marks, undefined, href);
  }
  // Other marks on the same run survive the drop.
  const hardened = hardenCommentLinks(
    doc({ type: "paragraph", content: [{ type: "text", text: "t", marks: [{ type: "bold" }, { type: "link", attrs: { href: "javascript:x" } }] }] }),
  );
  assert.deepEqual(hardened.content![0].content![0].marks, [{ type: "bold" }]);
});

test("mailto links are allowed", () => {
  const result = parseCommentBody(
    doc({ type: "paragraph", content: [{ type: "text", text: "me", marks: [{ type: "link", attrs: { href: "mailto:a@b.invalid" } }] }] }),
  );
  assert.ok(!isCommentBodyError(result));
  assert.equal(result.json.content![0].content![0].marks![0].type, "link");
});

test("commentBodyText joins textblocks with newlines and treats a hard break as one", () => {
  const node = pmCommentContentSchema.nodeFromJSON(
    doc(
      { type: "paragraph", content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }] },
      { type: "blockquote", content: [para("three")] },
      { type: "bulletList", content: [{ type: "listItem", content: [para("four")] }] },
    ),
  );
  assert.equal(commentBodyText(node), "one\ntwo\nthree\nfour");
  assert.equal(commentBodyTextFromJSON({ type: "nonsense" }), "");
});

test("commentDocFromText mirrors the migration: one paragraph per non-empty line", () => {
  assert.deepEqual(commentDocFromText("a\n\n  b  \r\nc"), doc(para("a"), para("b"), para("c")));
  assert.deepEqual(commentDocFromText("  \n"), doc({ type: "paragraph" }));
  const text = "first line\nsecond line";
  assert.equal(commentBodyTextFromJSON(commentDocFromText(text)), text);
});
