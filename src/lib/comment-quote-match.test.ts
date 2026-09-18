import { test } from "node:test";
import assert from "node:assert/strict";
import { pmSchema } from "./tiptap-schema";
import { END_CHARS, findQuoteInTarget, flattenForMatch, matchQuoteAcross, normalizeForMatch } from "./comment-quote-match";

// PLAN.md §23n / docs/COLLAB.md §9 — the matcher's table. What must match
// (across a paragraph break, with curly quotes and a dash, with a typo in
// the middle), what must not (a different sentence, a short common phrase
// in the wrong place), and the one invariant every hit carries: the stored
// text is `textBetween` at a verified range, never the query.

const para = (...runs: (string | { br: true })[]) => ({
  type: "paragraph",
  content: runs.map((run) => (typeof run === "string" ? { type: "text", text: run } : { type: "hardBreak" })),
});
const doc = (...content: object[]) => pmSchema.nodeFromJSON({ type: "doc", content });

const ARTICLE = doc(
  para("The quick brown fox jumps over the lazy dog near the river bank."),
  para("A second paragraph — with a dash, “curly quotes” and an ellipsis… follows."),
  para("The quick brown fox appears again here, in a third paragraph."),
);

test("normalizeForMatch folds quotes, dashes, ellipses and whitespace, and maps back", () => {
  const { text, map } = normalizeForMatch("  “Hello”\n\t— world…  ");
  assert.equal(text, '"Hello" - world...');
  // The second quote character came from the closing curly quote at index 8.
  assert.equal(map[text.indexOf('"', 1)], 8);
  // Every three dots point at the one ellipsis character.
  const dots = text.indexOf("...");
  assert.equal(map[dots], map[dots + 2]);
  assert.equal(normalizeForMatch("ﬁne").text, "fine");
});

test("an exact quote is found, and the stored text is textBetween at the range", () => {
  const target = flattenForMatch(ARTICLE);
  const match = findQuoteInTarget(target, "brown fox jumps");
  assert.ok(match);
  assert.equal(match.tier, "exact");
  assert.equal(ARTICLE.textBetween(match.from, match.to, " "), "brown fox jumps");
  assert.equal(match.quotedText, "brown fox jumps");
});

test("a quote typed with straight quotes and a hyphen matches the article's curly quotes and dash", () => {
  const target = flattenForMatch(ARTICLE);
  const match = findQuoteInTarget(target, 'with a dash, "curly quotes" and an ellipsis...');
  assert.ok(match);
  assert.equal(match.quotedText, "with a dash, “curly quotes” and an ellipsis…");
});

test("a quote spanning a paragraph break matches, which findQuoteOccurrences cannot do", () => {
  const target = flattenForMatch(ARTICLE);
  const match = findQuoteInTarget(target, "near the river bank.\n\nA second paragraph");
  assert.ok(match);
  // The range crosses the block boundary and textBetween still reproduces it.
  assert.equal(ARTICLE.textBetween(match.from, match.to, " "), "near the river bank. A second paragraph");
});

test("a hard break inside a paragraph reads as a space, in the match and in the stored text", () => {
  const target = flattenForMatch(doc(para("line one", { br: true }, "line two")));
  const match = findQuoteInTarget(target, "one line two");
  assert.ok(match);
  assert.equal(match.quotedText, "one line two");
});

test("several occurrences pick the nearest to `near`, else the first", () => {
  const target = flattenForMatch(ARTICLE);
  const first = findQuoteInTarget(target, "The quick brown fox");
  assert.ok(first);
  assert.equal(first.from, 1);
  const thirdParagraphStart = ARTICLE.content.size - ARTICLE.lastChild!.nodeSize + 1;
  const nearest = findQuoteInTarget(target, "The quick brown fox", { near: thirdParagraphStart });
  assert.ok(nearest);
  assert.equal(nearest.from, thirdParagraphStart);
});

test("the hint tier verifies the client's offsets and refuses ones that name other text", () => {
  const target = flattenForMatch(ARTICLE);
  const good = findQuoteInTarget(target, "quick brown", { hint: { from: 5, to: 16 }, tiers: ["hint"] });
  assert.ok(good);
  assert.equal(good.tier, "hint");
  const bad = findQuoteInTarget(target, "quick brown", { hint: { from: 1, to: 12 }, tiers: ["hint"] });
  assert.equal(bad, null);
});

test("the ends tier catches a typo in the middle of a long quote and returns the corrected text", () => {
  const sentence = "The quick brown fox jumps over the lazy dog near the river bank, and a second paragraph follows it.";
  const target = flattenForMatch(doc(para(sentence)));
  assert.ok(sentence.length >= END_CHARS * 2 + 1);
  const typo = sentence.replace("lazy dog", "lasy dgo");
  const match = findQuoteInTarget(target, typo);
  assert.ok(match);
  assert.equal(match.tier, "ends");
  assert.equal(match.quotedText, sentence);
});

test("the ends tier refuses a span whose length is far from the query's", () => {
  const head = "The quick brown fox jumps over the lazy dog near";
  const tail = "in a third paragraph.";
  // Head is in paragraph one, tail in paragraph three: the span is three
  // paragraphs long against a query of two clauses.
  const target = flattenForMatch(ARTICLE);
  const match = findQuoteInTarget(target, `${head} ... ${tail}`);
  assert.equal(match, null);
});

test("a short quote never goes through the ends tier", () => {
  const target = flattenForMatch(ARTICLE);
  assert.equal(findQuoteInTarget(target, "brown fix jumps"), null);
});

test("text that is not in the target does not match", () => {
  const target = flattenForMatch(ARTICLE);
  assert.equal(findQuoteInTarget(target, "an entirely different sentence"), null);
  assert.equal(findQuoteInTarget(target, ""), null);
});

test("matchQuoteAcross runs exact across every candidate before ends, and honours a hinted candidate first", () => {
  const post = flattenForMatch(ARTICLE);
  const comment = flattenForMatch(doc(para("I think the quick brown fox is overrated, honestly.")));
  const candidates = [
    { key: "comment", target: comment },
    { key: "post", target: post },
  ];
  // Present in both; priority order wins.
  const both = matchQuoteAcross(candidates, "quick brown fox");
  assert.equal(both?.key, "comment");
  // A hint reorders: the post is tried first.
  const hinted = matchQuoteAcross(candidates, "quick brown fox", { key: "post" });
  assert.equal(hinted?.key, "post");
  // Case is not folded: the article capitalizes this, the comment does not.
  assert.equal(matchQuoteAcross(candidates, "the quick brown fox", { key: "post" })?.key, "comment");
  // Exact in the second candidate beats a fuzzy hit in the first.
  const sentence = "The quick brown fox jumps over the lazy dog near the river bank, and a second paragraph follows it.";
  const fuzzyFirst = [
    { key: "typo", target: flattenForMatch(doc(para(sentence.replace("lazy", "lasy")))) },
    { key: "exact", target: flattenForMatch(doc(para(sentence))) },
  ];
  assert.equal(matchQuoteAcross(fuzzyFirst, sentence)?.key, "exact");
  assert.equal(matchQuoteAcross(fuzzyFirst, sentence.replace("dog", "dgo"))?.match.tier, "ends");
});
