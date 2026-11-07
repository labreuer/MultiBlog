import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { pmDocContentSchema, pmSchema } from "../tiptap-schema";
import { chipsToLinkedText } from "./linked-text";
import { ENTITY_CHIP, type ChipContext } from "./types";
import { UNKNOWN_PERSON } from "./kinds/mention";

// docs/ENTITY_CHIPS.md, step 1, item 9 — a post gets each chip's label as
// linked text, and the post-side schema, which has no chip node, accepts the
// result.

const context: ChipContext = {
  mention: {
    luke: { id: "luke", name: "Luke Breuer", initials: "LB", slug: "luke-breuer", deleted: false, botOf: null },
    gone: { id: "gone", name: "Gone Author", initials: "GA", slug: "gone-author", deleted: true, botOf: null },
  },
};

const chip = (kind: string, iid: string, data: Record<string, unknown>): JSONContent => ({
  type: ENTITY_CHIP,
  attrs: { kind, iid, data },
});
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const docOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

const source = docOf(
  para(text("Ask "), chip("mention", "i1", { userId: "luke" }), text(", not "), chip("mention", "i2", { userId: "gone" }), text(".")),
  para(chip("mention", "i3", { userId: "nobody" }), text(" and "), chip("future", "i4", { anything: 1 })),
);

test("the source is a doc the doc-side schema accepts and the post-side schema refuses", () => {
  pmDocContentSchema.nodeFromJSON(source).check();
  assert.throws(() => pmSchema.nodeFromJSON(source));
});

test("every chip becomes text the post-side schema accepts", () => {
  const converted = chipsToLinkedText(source, {}, context);
  const node = pmSchema.nodeFromJSON(converted);
  node.check();
  assert.equal(node.textBetween(0, node.content.size, "\n"), `Ask @Luke Breuer, not @Gone Author.\n${UNKNOWN_PERSON} and […]`);
  assert.doesNotMatch(JSON.stringify(converted), new RegExp(ENTITY_CHIP));
});

test("a live chip is linked where a post's reader goes, and the link records the chip", () => {
  const converted = chipsToLinkedText(source, {}, context);
  assert.deepEqual(converted.content?.[0].content?.[1], {
    type: "text",
    text: "@Luke Breuer",
    marks: [{ type: "link", attrs: { href: "/authors/luke-breuer", chip: { kind: "mention", iid: "i1", targets: ["luke"] } } }],
  });
});

test("a deleted or unknown chip is struck through and unlinked", () => {
  const converted = chipsToLinkedText(source, {}, context);
  assert.deepEqual(converted.content?.[0].content?.[3], { type: "text", text: "@Gone Author", marks: [{ type: "strike" }] });
  assert.deepEqual(converted.content?.[1].content?.[0], { type: "text", text: UNKNOWN_PERSON, marks: [{ type: "strike" }] });
  assert.deepEqual(converted.content?.[1].content?.[2], { type: "text", text: "[…]", marks: [{ type: "strike" }] });
});

test("the doc's style decides the label", () => {
  const converted = chipsToLinkedText(source, { mention: { form: "initials" } }, context);
  assert.equal(converted.content?.[0].content?.[1].text, "LB");
});

test("a doc's own link can't claim to stand for a chip", () => {
  const forged = docOf(
    para(text("me", [{ type: "link", attrs: { href: "/authors/luke-breuer", chip: { kind: "mention", iid: "x", targets: ["luke"] } } }])),
  );
  const converted = chipsToLinkedText(forged, {}, context);
  assert.deepEqual(converted.content?.[0].content?.[0].marks, [{ type: "link", attrs: { href: "/authors/luke-breuer", chip: null } }]);
});

test("a doc with no chips comes back equal, and the input is never mutated", () => {
  const plain = docOf(para(text("No chips here.", [{ type: "bold" }])));
  const before = JSON.stringify(source);
  assert.deepEqual(chipsToLinkedText(plain, {}, context), plain);
  chipsToLinkedText(source, {}, context);
  assert.equal(JSON.stringify(source), before);
});

test("a citation whose words are formatted becomes a linked text node per run, code plain", () => {
  const work = { id: "bu", key: "barfield1957", short: "BU", names: "Barfield", year: 1957, title: "Saving the Appearances", deleted: false, file: null };
  const entry = { authors: "Barfield", year: "1957", title: "Saving the Appearances", titleIsContainer: true, source: "" };
  const cited = docOf(para(chip("citation", "c1", { items: [{ refId: "bu", prefix: "see *especially* `this`" }] })));
  const converted = chipsToLinkedText(cited, {}, { citation: { bu: { ...work, entry } } });
  pmSchema.nodeFromJSON(converted).check();
  const link = { type: "link", attrs: { href: "/references/barfield1957", chip: { kind: "citation", iid: "c1", targets: ["bu"] } } };
  assert.deepEqual(converted.content?.[0].content, [
    { type: "text", text: "(see ", marks: [link] },
    { type: "text", text: "especially", marks: [{ type: "italic" }, link] },
    { type: "text", text: " this BU)", marks: [link] },
  ]);
});
