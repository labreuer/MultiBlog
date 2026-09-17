import { test } from "node:test";
import assert from "node:assert/strict";
import { pmCommentContentSchema, pmSchema } from "./tiptap-schema";
import { applyQuoteResolutions, clearUnassignedAnchorIds, extractQuoteCandidates, MIN_INLINE_QUOTE_CHARS } from "./comment-quote-extract";
import { commentBodyText } from "./comment-body";

// PLAN.md §23n — which spans are candidates, and §23f — what the rewrite
// does to a matched and an unmatched one.

const text = (t: string, marks?: object[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (...content: object[]) => ({ type: "paragraph", content });
const bq = (attrs: object, ...content: object[]) => ({ type: "blockquote", attrs, content });
const body = (...content: object[]) => pmCommentContentSchema.nodeFromJSON({ type: "doc", content });

test("outermost blockquotes are block candidates; a nested one is not", () => {
  const doc = body(
    para(text("Before.")),
    bq({ anchorId: null }, para(text("first line")), bq({ anchorId: "inner" }, para(text("nested")))),
    bq({ anchorId: "pending:x" }, para(text("second"))),
  );
  const candidates = extractQuoteCandidates(doc);
  const blocks = candidates.filter((c) => c.kind === "block");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "first line\nnested");
  assert.equal(blocks[0].anchorId, null);
  assert.equal(blocks[1].anchorId, "pending:x");
});

test("a typed quote long enough is an inline candidate; a short or code-marked one is not", () => {
  const long = "a".repeat(MIN_INLINE_QUOTE_CHARS);
  const doc = body(
    para(text(`He said "${long}" and also "short" and `), text('"in code here at all"', [{ type: "code" }]), text(" and “curly quoted words here”.")),
  );
  const inlines = extractQuoteCandidates(doc).filter((c) => c.kind === "inline");
  assert.deepEqual(
    inlines.map((c) => c.text),
    [long, "curly quoted words here"],
  );
  assert.ok(inlines.every((c) => c.typedQuotes));
  // The range excludes the quote characters.
  assert.equal(doc.textBetween(inlines[0].from, inlines[0].to), long);
});

test("an existing quote mark is an inline candidate carrying its anchor id", () => {
  const doc = body(para(text("Recall "), text("the quoted words", [{ type: "quote", attrs: { anchorId: "row1" } }]), text(" here.")));
  const inlines = extractQuoteCandidates(doc).filter((c) => c.kind === "inline");
  assert.equal(inlines.length, 1);
  assert.equal(inlines[0].anchorId, "row1");
  assert.equal(inlines[0].typedQuotes, false);
  assert.equal(inlines[0].text, "the quoted words");
});

test("a matched block is rewritten to the source's paragraphs and gets its anchor id", () => {
  const source = pmSchema.nodeFromJSON({
    type: "doc",
    content: [para(text("First source paragraph.")), para(text("Second source paragraph, quoted too."))],
  });
  const doc = body(para(text("Reply:")), bq({ anchorId: null }, para(text("first source paragrph. second sourse paragraph, quoted too."))));
  const [candidate] = extractQuoteCandidates(doc);
  const from = 1;
  const to = source.content.size - 1;
  const rewritten = applyQuoteResolutions(doc, [
    { candidate, anchorId: "row1", source, from, to, quotedText: source.textBetween(from, to, " ") },
  ]);
  const quote = rewritten.child(1);
  assert.equal(quote.type.name, "blockquote");
  assert.equal(quote.attrs.anchorId, "row1");
  assert.equal(quote.childCount, 2);
  assert.equal(quote.child(0).textContent, "First source paragraph.");
  assert.equal(quote.child(1).textContent, "Second source paragraph, quoted too.");
  assert.equal(commentBodyText(rewritten), "Reply:\nFirst source paragraph.\nSecond source paragraph, quoted too.");
});

test("an unmatched block keeps its words and loses its anchor id", () => {
  const doc = body(bq({ anchorId: "pending:x" }, para(text("not from anywhere"))));
  const [candidate] = extractQuoteCandidates(doc);
  const rewritten = applyQuoteResolutions(doc, [{ candidate, anchorId: null }]);
  assert.equal(rewritten.child(0).attrs.anchorId, null);
  assert.equal(rewritten.child(0).textContent, "not from anywhere");
});

test("a matched typed quote becomes the derived text under the quote mark, quote characters dropped", () => {
  const source = pmSchema.nodeFromJSON({ type: "doc", content: [para(text("The quick brown fox jumps over the lazy dog."))] });
  const doc = body(para(text('I liked "the quick brown fox jumps" a lot.')));
  const [candidate] = extractQuoteCandidates(doc);
  const from = source.textContent.indexOf("quick") + 1;
  const to = from + "quick brown fox jumps".length;
  const rewritten = applyQuoteResolutions(doc, [
    { candidate, anchorId: "row2", source, from, to, quotedText: "quick brown fox jumps" },
  ]);
  const paragraph = rewritten.child(0);
  assert.equal(paragraph.textContent, "I liked quick brown fox jumps a lot.");
  const marked = paragraph.child(1);
  assert.equal(marked.text, "quick brown fox jumps");
  assert.equal(marked.marks[0].type.name, "quote");
  assert.equal(marked.marks[0].attrs.anchorId, "row2");
});

test("an unmatched existing quote mark comes off and the words get literal quotes back", () => {
  const doc = body(para(text("Recall "), text("the quoted words", [{ type: "quote", attrs: { anchorId: "old" } }]), text(" here.")));
  const [candidate] = extractQuoteCandidates(doc);
  const rewritten = applyQuoteResolutions(doc, [{ candidate, anchorId: null }]);
  assert.equal(rewritten.child(0).textContent, 'Recall "the quoted words" here.');
  assert.ok(!rewritten.child(0).content.content.some((n) => n.marks.some((m) => m.type.name === "quote")));
});

test("several resolutions apply last-first so earlier positions stay valid", () => {
  const source = pmSchema.nodeFromJSON({ type: "doc", content: [para(text("Alpha beta gamma delta epsilon zeta."))] });
  const doc = body(bq({ anchorId: null }, para(text("Alpha beta gamma"))), para(text("x")), bq({ anchorId: null }, para(text("delta epsilon zeta."))));
  const [first, second] = extractQuoteCandidates(doc);
  const rewritten = applyQuoteResolutions(doc, [
    { candidate: first, anchorId: "a", source, from: 1, to: 17, quotedText: "Alpha beta gamma" },
    { candidate: second, anchorId: "b", source, from: 18, to: 37, quotedText: "delta epsilon zeta." },
  ]);
  assert.equal(rewritten.child(0).attrs.anchorId, "a");
  assert.equal(rewritten.child(2).attrs.anchorId, "b");
  assert.equal(rewritten.child(2).textContent, "delta epsilon zeta.");
});

test("clearUnassignedAnchorIds nulls a stale block id and drops a stale mark", () => {
  const json = {
    type: "doc",
    content: [
      { type: "blockquote", attrs: { anchorId: "kept" }, content: [{ type: "blockquote", attrs: { anchorId: "stale" }, content: [] }] },
      { type: "paragraph", content: [{ type: "text", text: "t", marks: [{ type: "quote", attrs: { anchorId: "gone" } }, { type: "bold" }] }] },
    ],
  };
  const cleared = clearUnassignedAnchorIds(json, new Set(["kept"]));
  assert.equal(cleared.content![0].attrs!.anchorId, "kept");
  assert.equal(cleared.content![0].content![0].attrs!.anchorId, null);
  assert.deepEqual(cleared.content![1].content![0].marks, [{ type: "bold" }]);
});
