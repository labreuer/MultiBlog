import { test } from "node:test";
import assert from "node:assert/strict";
import { pmSchema } from "./tiptap-schema";
import {
  LEAD_CHARS,
  blockText,
  blocksOfRange,
  docBlocks,
  docOutline,
  docText,
  findHeading,
  headingAbove,
  searchSections,
  sectionOf,
  textSize,
} from "./doc-text";
import { docContentToMarkdown, markdownToDocContent, markdownToText } from "./markdown-import";

// docs/MCP.md §6 — a doc as a machine client reads it: the text form, block
// numbers, the outline's sizes, leads and depth, sections, and the passages
// search ranks within one doc.

const text = (t: string) => ({ type: "text", text: t });
const para = (...runs: (string | { br: true })[]) => ({
  type: "paragraph",
  content: runs.map((run) => (typeof run === "string" ? text(run) : { type: "hardBreak" })),
});
const heading = (level: number, t: string) => ({ type: "heading", attrs: { level }, content: [text(t)] });
const doc = (...content: object[]) => pmSchema.nodeFromJSON({ type: "doc", content });

// A chat's shape: every turn under its author's name.
const CHAT = doc(
  heading(1, "A conversation"),
  heading(2, "Luke Breuer"),
  para("What did Barfield mean by participation?"),
  heading(2, "Claude"),
  para("Barfield distinguished original participation from final participation, and the long answer goes on."),
  heading(3, "Original participation"),
  para("The pre-modern sense that perceiver and perceived share one world."),
  heading(2, "Luke Breuer"),
  para("And idolatry?"),
  heading(2, "Claude"),
  para("Idolatry is the collective representations taken as objects."),
);

test("blocks are numbered from 1 and know their headings", () => {
  const blocks = docBlocks(CHAT);
  assert.equal(blocks.length, 11);
  assert.equal(blocks[0].number, 1);
  assert.deepEqual(blocks[1].heading, { level: 2, text: "Luke Breuer" });
  assert.equal(blocks[2].heading, null);
  assert.equal(blocks[0].from, 0);
  assert.equal(blocks[1].from, blocks[0].to);
});

test("the text form puts a line break between textblocks, table cells and hard breaks alike", () => {
  const table = {
    type: "table",
    content: [
      { type: "tableRow", content: [{ type: "tableCell", content: [para("a")] }, { type: "tableCell", content: [para("b")] }] },
    ],
  };
  const list = { type: "bulletList", content: [{ type: "listItem", content: [para("one")] }, { type: "listItem", content: [para("two")] }] };
  const d = doc(para("x", { br: true }, "y"), list, table);
  const blocks = docBlocks(d);
  assert.equal(blockText(blocks[0].node), "x\ny");
  assert.equal(blocks[1].text, "one\ntwo");
  assert.equal(blocks[2].text, "a\nb");
  assert.equal(docText(blocks), "x\ny\none\ntwo\na\nb");
  assert.equal(textSize(blocks), docText(blocks).length);
});

test("a section runs to the next heading at its level or above", () => {
  const blocks = docBlocks(CHAT);
  // The first "Claude" turn holds its own H3.
  assert.deepEqual(sectionOf(blocks, 4), { from: 4, to: 7 });
  assert.deepEqual(sectionOf(blocks, 6), { from: 6, to: 7 });
  assert.deepEqual(sectionOf(blocks, 1), { from: 1, to: 11 });
  assert.deepEqual(sectionOf(blocks, 10), { from: 10, to: 11 });
});

test("the outline is flat, sized, and leads repeated headings with their opening words", () => {
  const blocks = docBlocks(CHAT);
  const { entries, deeper } = docOutline(blocks);
  assert.equal(deeper, 0);
  assert.deepEqual(
    entries.map((e) => [e.level, e.text, e.block]),
    [
      [1, "A conversation", 1],
      [2, "Luke Breuer", 2],
      [2, "Claude", 4],
      [3, "Original participation", 6],
      [2, "Luke Breuer", 8],
      [2, "Claude", 10],
    ],
  );
  // A unique heading carries no lead; a repeated one does, cut on a word.
  assert.equal(entries[0].lead, undefined);
  assert.equal(entries[1].lead, "What did Barfield mean by participation?");
  assert.ok(entries[2].lead!.endsWith("…"));
  assert.ok(entries[2].lead!.length <= LEAD_CHARS + 1);
  // A section's size is its text form, heading included.
  assert.equal(entries[1].chars, "Luke Breuer\nWhat did Barfield mean by participation?".length);
});

test("depth counts from the shallowest level covered, and within keeps one section", () => {
  const blocks = docBlocks(CHAT);
  const top = docOutline(blocks, { depth: 1 });
  assert.deepEqual(top.entries.map((e) => e.block), [1]);
  assert.equal(top.deeper, 5);
  const turns = docOutline(blocks, { depth: 2 });
  assert.deepEqual(turns.entries.map((e) => e.block), [1, 2, 4, 8, 10]);
  assert.equal(turns.deeper, 1);
  const inside = docOutline(blocks, { within: sectionOf(blocks, 4), depth: 1 });
  assert.deepEqual(inside.entries.map((e) => e.block), [4]);
  assert.equal(inside.deeper, 1);
});

test("a heading is found by text or block number, and a repeated one is refused with where they are", () => {
  const blocks = docBlocks(CHAT);
  const byText = findHeading(blocks, "Original participation");
  assert.equal(byText.kind, "found");
  assert.equal(byText.kind === "found" && byText.block.number, 6);
  assert.deepEqual(findHeading(blocks, "Claude"), { kind: "ambiguous", blocks: [4, 10], total: 2 });
  assert.equal(findHeading(blocks, 3).kind, "not-heading");
  assert.equal(findHeading(blocks, 99).kind, "none");
  assert.equal(findHeading(blocks, "Nobody").kind, "none");
  // Under the matcher's folding: a curly quote in the heading, a straight one typed.
  const curly = docBlocks(doc(heading(2, "Barfield’s idea")));
  assert.equal(findHeading(curly, "Barfield's idea").kind, "found");
});

test("blocksOfRange and headingAbove place a range", () => {
  const blocks = docBlocks(CHAT);
  const fifth = blocks[4];
  assert.deepEqual(blocksOfRange(blocks, fifth.from + 2, fifth.from + 5), { from: 5, to: 5 });
  assert.deepEqual(blocksOfRange(blocks, blocks[4].from + 2, blocks[6].from + 3), { from: 5, to: 7 });
  assert.equal(headingAbove(blocks, 7)?.number, 6);
  assert.equal(headingAbove(blocks, 5)?.number, 4);
});

test("search sections end at the next heading of any level and split long runs on block boundaries", () => {
  const blocks = docBlocks(CHAT);
  assert.deepEqual(searchSections(blocks), [
    { from: 1, to: 1 },
    { from: 2, to: 3 },
    { from: 4, to: 5 },
    { from: 6, to: 7 },
    { from: 8, to: 9 },
    { from: 10, to: 11 },
  ]);
  const long = docBlocks(doc(heading(1, "H"), para("a".repeat(30)), para("b".repeat(30)), para("c".repeat(30))));
  assert.deepEqual(searchSections(long, 50), [
    { from: 1, to: 2 },
    { from: 3, to: 3 },
    { from: 4, to: 4 },
  ]);
  // Text before the first heading is a passage of its own.
  const preamble = docBlocks(doc(para("intro"), heading(2, "Then")));
  assert.deepEqual(searchSections(preamble), [
    { from: 1, to: 1 },
    { from: 2, to: 2 },
  ]);
});

test("a doc's Markdown drops the marks Markdown can't say and re-parses to the same body", () => {
  const marked = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "kept ", marks: [{ type: "authorHighlight", attrs: { authorId: "u1" } }] },
          { type: "text", text: "bold", marks: [{ type: "bold" }, { type: "annotation", attrs: { id: "a1" } }] },
        ],
      },
    ],
  };
  const markdown = docContentToMarkdown(marked);
  assert.equal(markdown.trim(), "kept **bold**");
  assert.deepEqual(markdownToDocContent(markdown).body, {
    type: "doc",
    content: [{ type: "paragraph", content: [text("kept "), { type: "text", text: "bold", marks: [{ type: "bold" }] }] }],
  });
});

test("markdownToText is the text a doc made from the Markdown would hold, with no title taken", () => {
  assert.equal(markdownToText("the **key** claim"), "the key claim");
  assert.equal(markdownToText("[the paper](/link/abc) says"), "the paper says");
  assert.equal(markdownToText("# Heading\n\nbody"), "Heading\nbody");
});
