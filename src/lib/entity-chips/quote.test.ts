import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { findAllExact, findByEnds, flattenForMatch, nearMisses } from "../comment-quote-match";
import { blockText, docBlocks } from "../doc-text";
import { annotationContentToMarkdown, docContentToMarkdown, markdownToBlocks } from "../markdown-import";
import { resolveQuote } from "../quote-resolve";
import { pmDocContentSchema } from "../tiptap-schema";
import { MENTION, type MentionUser } from "./kinds/mention";
import { chipMarkdowns, chipsIn } from "./renderings";
import { chipLabelsIn, displayTextBetween } from "./text";
import { CHIP_ANCHOR_TEXT, DEFAULT_CHIP_STYLES, type ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, MCP items 1 and 3 — a doc as a machine client reads
// it, and a quote of what it read finding its place: a chip is its label in
// text and in a quote, its chip kind's syntax in Markdown, and its anchor
// text in whatever a match stores.

const user = (id: string, name: string, slug: string, more: Partial<MentionUser> = {}): MentionUser => ({
  id,
  name,
  initials: "",
  slug,
  deleted: false,
  botOf: null,
  ...more,
});
const INPUTS: ChipInputs = {
  styles: DEFAULT_CHIP_STYLES,
  context: {
    [MENTION]: {
      u1: user("u1", "Ada Lovelace", "ada"),
      u2: user("u2", "Grace [Amazing] Hopper", "grace"),
      gone: user("gone", "Alan Turing", "alan", { deleted: true }),
    },
  },
};

const chip = (iid: string, userId: string): JSONContent => ({ type: "entityChip", attrs: { kind: MENTION, iid, data: { userId } } });
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const docOf = (...blocks: JSONContent[]) => pmDocContentSchema.nodeFromJSON({ type: "doc", content: blocks });

const DOC = docOf(
  para(text("Ask "), chip("i1", "u1"), text(" about the engine, then ask "), chip("i2", "u1"), text(" again.")),
  para(text("Reviewed by "), chip("i3", "u2"), text(".")),
);
const LABELS = chipLabelsIn(DOC, INPUTS);
const asText = (markdown: string) => markdown;

test("text: a block reads with each chip as its label, and with nothing there when no labels are given", () => {
  assert.equal(blockText(DOC.child(0), LABELS), "Ask @Ada Lovelace about the engine, then ask @Ada Lovelace again.");
  assert.equal(blockText(DOC.child(0)), "Ask  about the engine, then ask  again.");
  assert.deepEqual(
    docBlocks(DOC, LABELS).map((block) => block.text),
    ["Ask @Ada Lovelace about the engine, then ask @Ada Lovelace again.", "Reviewed by @Grace [Amazing] Hopper."],
  );
});

test("quote: what was read is what matches, and what is stored holds the chip's anchor text", () => {
  const target = flattenForMatch(DOC, LABELS);
  const [match, ...others] = findAllExact(target, "Ask @Ada Lovelace about the engine");
  assert.equal(others.length, 0);
  assert.equal(match.quotedText, `Ask ${CHIP_ANCHOR_TEXT} about the engine`);
  // The range is the doc's own: the chip is one position wide in it.
  assert.equal(DOC.textBetween(match.from, match.to, " "), match.quotedText);
  assert.equal(displayTextBetween(DOC, match.from, match.to, LABELS), "Ask @Ada Lovelace about the engine");
});

test("quote: a label alone finds every chip that wears it", () => {
  const target = flattenForMatch(DOC, LABELS);
  const matches = findAllExact(target, "@Ada Lovelace");
  assert.deepEqual(matches.map((match) => match.quotedText), [CHIP_ANCHOR_TEXT, CHIP_ANCHOR_TEXT]);
  assert.deepEqual(matches.map((match) => match.to - match.from), [1, 1]);
  // A prefix tells them apart, as for any repeated passage.
  const second = resolveQuote(target, { quote: "@Ada Lovelace", prefix: "then ask" }, asText);
  assert.equal(second.kind, "found");
  assert.equal(second.kind === "found" && second.matches.length, 1);
});

test("quote: one that begins or ends inside a label takes the whole chip, and says so", () => {
  const target = flattenForMatch(DOC, LABELS);
  const [head] = findAllExact(target, "Ask @Ada");
  assert.deepEqual({ quotedText: head.quotedText, widened: head.widened }, { quotedText: `Ask ${CHIP_ANCHOR_TEXT}`, widened: true });
  const [tail] = findAllExact(target, "Lovelace about the engine");
  assert.deepEqual({ quotedText: tail.quotedText, widened: tail.widened }, { quotedText: `${CHIP_ANCHOR_TEXT} about the engine`, widened: true });
  // A name alone finds each mention of it, once each, however many letters of the label it matches.
  const named = findAllExact(target, "Ada");
  assert.deepEqual(
    named.map((match) => [match.quotedText, match.widened]),
    [
      [CHIP_ANCHOR_TEXT, true],
      [CHIP_ANCHOR_TEXT, true],
    ],
  );
  // The whole label is a match as written, and not marked.
  assert.equal(findAllExact(target, "Ask @Ada Lovelace")[0].widened, undefined);
  // By its ends, the same, when the passage's own edge is the one inside a label.
  const [byEnds] = findByEnds(target, "Lovelace about", "the engine");
  assert.deepEqual({ quotedText: byEnds.quotedText, widened: byEnds.widened }, { quotedText: `${CHIP_ANCHOR_TEXT} about the engine`, widened: true });
  // An end of `start` that falls inside one is in the passage's middle, and cuts nothing.
  assert.equal(findByEnds(target, "Ask @Ada", "the engine")[0].widened, undefined);
});

test("quote: a miss suggests what reads as the doc does", () => {
  const target = flattenForMatch(DOC, LABELS);
  const missed = resolveQuote(target, { quote: "Ask @Ada about the engine, then" }, asText);
  assert.equal(missed.kind, "none");
  assert.ok(missed.kind === "none" && missed.nearMisses.length > 0);
  // A suggestion is shown, never stored: a chip in one is its label.
  const suggested = nearMisses(target, "ask Ada Lovelace about the engines then");
  assert.ok(suggested.some((miss) => miss.quotedText.includes("@Ada Lovelace")));
  for (const miss of suggested) assert.ok(!miss.quotedText.includes(CHIP_ANCHOR_TEXT));
});

test("quote: a passage named by its ends may start, end or run across a chip", () => {
  const target = flattenForMatch(DOC, LABELS);
  const [match] = findByEnds(target, "Ask @Ada Lovelace about", "ask @Ada Lovelace");
  assert.equal(match.quotedText, `Ask ${CHIP_ANCHOR_TEXT} about the engine, then ask ${CHIP_ANCHOR_TEXT}`);
});

test("quote: without labels no quote crosses a chip, as before there were any", () => {
  const target = flattenForMatch(DOC);
  assert.deepEqual(findAllExact(target, "Ask @Ada Lovelace about the engine"), []);
  assert.equal(findAllExact(target, "about the engine").length, 1);
});

test("markdown: a chip is written in its kind's syntax, from the whole doc's pass", () => {
  const markdown = chipMarkdowns(chipsIn(DOC), INPUTS.styles, INPUTS.context);
  assert.equal(
    docContentToMarkdown(DOC.toJSON(), markdown),
    "Ask [@Ada Lovelace](/authors/ada) about the engine, then ask [@Ada Lovelace](/authors/ada) again.\n\n" +
      "Reviewed by [@Grace \\[Amazing\\] Hopper](/authors/grace).",
  );
  // One block of it, as a ranged read renders, with the same map.
  assert.equal(docContentToMarkdown({ type: "doc", content: [DOC.child(1).toJSON()] }, markdown), "Reviewed by [@Grace \\[Amazing\\] Hopper](/authors/grace).");
  // A note's body, through its own writer.
  assert.equal(annotationContentToMarkdown({ type: "doc", content: [DOC.child(1).toJSON()] }, markdown), "Reviewed by [@Grace \\[Amazing\\] Hopper](/authors/grace).");
});

test("markdown: an account that is gone is struck through, and an unknown one keeps its id", () => {
  const doc = docOf(para(chip("d1", "gone"), text(" and "), chip("x1", "nobody")));
  const markdown = chipMarkdowns(chipsIn(doc), INPUTS.styles, INPUTS.context);
  assert.equal(
    docContentToMarkdown(doc.toJSON(), markdown),
    "~~[@Alan Turing](/authors/alan)~~ and ~~[@unknown person](/authors/nobody)~~",
  );
});

test("markdown: the @ is written whatever the style, since the parse keys on it", () => {
  const doc = docOf(para(chip("i1", "u1")));
  const initials: ChipInputs = {
    styles: { [MENTION]: { form: "initials" } },
    context: { [MENTION]: { u1: user("u1", "Ada Lovelace", "ada", { initials: "AL" }) } },
  };
  assert.equal(docContentToMarkdown(doc.toJSON(), chipMarkdowns(chipsIn(doc), initials.styles, initials.context)), "[@AL](/authors/ada)");
});

test("markdown: a link written by hand in a mention's shape is escaped, and reads back as the link it was", () => {
  const link = (href: string) => [{ type: "link", attrs: { href } }];
  const doc = docOf(
    para(text("@Andrew", link("/authors/andrew")), text(" and "), text("his page", link("/authors/andrew")), text(" and "), text("@home", link("/elsewhere"))),
  );
  const written = docContentToMarkdown(doc.toJSON());
  assert.equal(written, "[\\@Andrew](/authors/andrew) and [his page](/authors/andrew) and [@home](/elsewhere)");
  const [block] = markdownToBlocks(written);
  assert.deepEqual(
    block.content?.map((node) => [node.text, node.marks?.[0]?.attrs?.href ?? null]),
    [
      ["@Andrew", "/authors/andrew"],
      [" and ", null],
      ["his page", "/authors/andrew"],
      [" and ", null],
      ["@home", "/elsewhere"],
    ],
  );
});

test("markdown: a chip with no entry in the map is left out rather than guessed", () => {
  const doc = docOf(para(text("Ask "), chip("i1", "u1"), text(".")));
  assert.equal(docContentToMarkdown(doc.toJSON()), "Ask .");
  assert.equal(docContentToMarkdown(doc.toJSON(), new Map()), "Ask .");
});
