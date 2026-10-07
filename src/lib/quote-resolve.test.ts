import { test } from "node:test";
import assert from "node:assert/strict";
import { pmDocContentSchema } from "./tiptap-schema";
import { filterByContext, findAllExact, findByEnds, flattenForMatch, nearMisses } from "./comment-quote-match";
import { contextOf, hasQuote, resolveQuote } from "./quote-resolve";
import { markdownToText } from "./markdown-import";

// docs/MCP.md §7 — the rejection surface of anchoring by quote: what must
// match, what must be refused as ambiguous, what is only ever suggested, and
// the one invariant every hit carries — its text is textBetween at a verified
// range, never the query.

const para = (...runs: (string | { text: string; bold?: boolean })[]) => ({
  type: "paragraph",
  content: runs.map((run) =>
    typeof run === "string"
      ? { type: "text", text: run }
      : { type: "text", text: run.text, marks: run.bold ? [{ type: "bold" }] : [] },
  ),
});
const doc = (...content: object[]) => pmDocContentSchema.nodeFromJSON({ type: "doc", content });

const ESSAY = doc(
  para("Barfield argues that ", { text: "original participation", bold: true }, " preceded the modern mind."),
  para("Coleridge’s imagination — the “esemplastic power” — unifies what it sees."),
  para("Barfield argues that idolatry follows when representations harden into things."),
  para("The end of the essay returns to the beginning and closes the circle."),
);

test("every exact occurrence is found and verified, never just the first", () => {
  const target = flattenForMatch(ESSAY);
  const matches = findAllExact(target, "Barfield argues that");
  assert.equal(matches.length, 2);
  for (const match of matches) assert.equal(ESSAY.textBetween(match.from, match.to, " "), "Barfield argues that");
});

test("prefix and suffix pick out the occurrence they stand beside", () => {
  const target = flattenForMatch(ESSAY);
  const both = findAllExact(target, "Barfield argues that");
  const idolatry = filterByContext(target, both, { suffix: "idolatry follows" });
  assert.equal(idolatry.length, 1);
  assert.ok(idolatry[0].from > both[0].from);
  // A prefix across a block boundary reads as the space it folds to.
  const second = filterByContext(target, both, { prefix: "unifies what it sees." });
  assert.deepEqual(second, idolatry);
  assert.deepEqual(filterByContext(target, both, { suffix: "nothing like this" }), []);
});

test("a passage named by its ends runs from the start to the first end after it", () => {
  const target = flattenForMatch(ESSAY);
  const [match, ...rest] = findByEnds(target, "Coleridge's imagination", "what it sees.");
  assert.equal(rest.length, 0);
  assert.equal(match.quotedText, "Coleridge’s imagination — the “esemplastic power” — unifies what it sees.");
  // Across blocks, and ambiguous when its start is.
  const twice = findByEnds(target, "Barfield argues", "mind.");
  assert.equal(twice.length, 1);
  const ambiguous = findByEnds(target, "Barfield argues", "the");
  assert.equal(ambiguous.length, 2);
});

test("resolveQuote folds typography, retries once as Markdown, and reports near misses on a miss", () => {
  const target = flattenForMatch(ESSAY);
  const plain = resolveQuote(target, { quote: 'the "esemplastic power" - unifies' }, markdownToText);
  assert.equal(plain.kind, "found");
  assert.equal(plain.kind === "found" && plain.viaMarkdown, false);

  const markdown = resolveQuote(target, { quote: "that **original participation** preceded" }, markdownToText);
  assert.equal(markdown.kind, "found");
  assert.equal(markdown.kind === "found" && markdown.viaMarkdown, true);
  assert.equal(
    markdown.kind === "found" && markdown.matches[0].quotedText,
    "that original participation preceded",
  );

  // Misremembered: no match, but the passage it was meant to be is suggested.
  const misremembered = resolveQuote(target, { quote: "idolatry results when representations harden" }, markdownToText);
  assert.equal(misremembered.kind, "none");
  assert.ok(misremembered.kind === "none" && misremembered.nearMisses.length >= 1);
  assert.ok(
    misremembered.kind === "none" && misremembered.nearMisses[0].quotedText.includes("representations harden"),
  );
});

test("only an exact match anchors: a long quote with a wrong middle is a suggestion, not a hit", () => {
  const target = flattenForMatch(ESSAY);
  const quote = "Coleridge's imagination - the \"esemplastic faculty\" - unifies what it sees.";
  assert.equal(findAllExact(target, quote).length, 0);
  const result = resolveQuote(target, { quote }, markdownToText);
  assert.equal(result.kind, "none");
  assert.ok(result.kind === "none" && result.nearMisses[0].quotedText.startsWith("Coleridge’s imagination"));
});

test("near misses need half the quote's words, and never overlap", () => {
  const target = flattenForMatch(ESSAY);
  assert.deepEqual(nearMisses(target, "entirely unrelated words here"), []);
  const misses = nearMisses(target, "Barfield argues that something", 5);
  assert.equal(misses.length, 2);
  assert.ok(misses[0].to <= misses[1].from || misses[1].to <= misses[0].from);
});

test("hasQuote and contextOf", () => {
  assert.equal(hasQuote({}), false);
  assert.equal(hasQuote({ start: "a" }), false);
  assert.equal(hasQuote({ start: "a", end: "b" }), true);
  assert.equal(hasQuote({ quote: "  " }), false);
  const target = flattenForMatch(ESSAY);
  const [match] = findAllExact(target, "esemplastic power");
  assert.equal(contextOf(target, match, 10), '…on - the "[esemplastic power]" - unifie…');
});
