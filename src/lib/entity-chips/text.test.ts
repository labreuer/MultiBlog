import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { quotedTextAt } from "../comment-quote-match";
import { extractText } from "../diff";
import { tableJsonToGrid } from "../table-grid";
import { extractMarkedText, pmDocContentSchema } from "../tiptap-schema";
import { MENTION, type MentionUser } from "./kinds/mention";
import { anchorLeafText, chipDisplayText, chipLabels, chipLabelsIn } from "./text";
import { CHIP_ANCHOR_TEXT, DEFAULT_CHIP_STYLES, type ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 7 — one rule for a chip's text, checked
// across every flattener that takes it, over the same body. A flattener that
// missed the rule would show nothing where a chip is, and fail nothing else.

const user = (id: string, name: string, slug: string): MentionUser => ({ id, name, initials: "", slug, deleted: false, botOf: null });
const INPUTS: ChipInputs = {
  styles: DEFAULT_CHIP_STYLES,
  context: { [MENTION]: { u1: user("u1", "Ada Lovelace", "ada"), u2: user("u2", "Grace Hopper", "grace") } },
};

const chip = (iid: string, userId: string, label?: string): JSONContent => ({
  type: "entityChip",
  attrs: { kind: MENTION, iid, data: { userId }, ...(label === undefined ? {} : { label }) },
});
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });

// "Ask <Ada> now", a hard break, "then <Grace>."
const inline = (labelled: boolean): JSONContent[] => [
  text("Ask "),
  chip("i1", "u1", labelled ? "@Ada Lovelace" : undefined),
  text(" now"),
  { type: "hardBreak" },
  text("then "),
  chip("i2", "u2", labelled ? "@Grace Hopper" : undefined),
  text("."),
];
const body = (labelled = false): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content: inline(labelled) }] });

test("labels are computed per instance id, from the same pass the surfaces draw", () => {
  assert.deepEqual([...chipLabels(body(), INPUTS)], [
    ["i1", "@Ada Lovelace"],
    ["i2", "@Grace Hopper"],
  ]);
  assert.deepEqual([...chipLabelsIn(pmDocContentSchema.nodeFromJSON(body()), INPUTS)], [...chipLabels(body(), INPUTS)]);
});

test("a chip's display text is its computed label, else the one on the node, else nothing", () => {
  const labels = new Map([["i1", "@Renamed"]]);
  assert.equal(chipDisplayText({ iid: "i1", label: "@Old" }, labels), "@Renamed");
  assert.equal(chipDisplayText({ iid: "i1", label: "@Old" }), "@Old");
  assert.equal(chipDisplayText({ iid: "i2", label: "@Old" }, labels), "@Old");
  assert.equal(chipDisplayText({ iid: "i1" }), "");
  assert.equal(chipDisplayText({ iid: "i1", label: 7 }), "");
  assert.equal(chipDisplayText(null), "");
});

// --- display mode: every flattener shows the same two labels ---------------

const DISPLAYED = ["@Ada Lovelace", "@Grace Hopper"];

test("display: extractText, from computed labels and from materialized ones", () => {
  const computed = extractText(body(), chipLabels(body(), INPUTS));
  assert.equal(computed, "Ask @Ada Lovelace nowthen @Grace Hopper.");
  assert.equal(extractText(body(true)), computed);
  // With neither, the chip is absent, which is the failure this file guards.
  assert.equal(extractText(body()), "Ask  nowthen .");
});

test("display: the table grid a CSV is written from", () => {
  const table = (labelled: boolean): JSONContent => ({
    type: "table",
    content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: inline(labelled) }] }] }],
  });
  const expected = "Ask @Ada Lovelace now\nthen @Grace Hopper.";
  assert.equal(tableJsonToGrid(table(false), chipLabels(body(), INPUTS))[0][0].text, expected);
  assert.equal(tableJsonToGrid(table(true))[0][0].text, expected);
  for (const label of DISPLAYED) assert.ok(expected.includes(label));
});

test("display: the text under an annotation mark, where a chip sits unmarked between marked runs", () => {
  const mark = [{ type: "annotation", attrs: { id: "a1" } }];
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          text("Before "),
          chip("i0", "u2", "@Grace Hopper"),
          text(" ask ", mark),
          chip("i1", "u1", "@Ada Lovelace"),
          text(" now", mark),
          chip("i2", "u2", "@Grace Hopper"),
          text(" after."),
        ],
      },
    ],
  };
  // The chip between the marked runs is in the span; the ones outside it are not.
  assert.equal(extractMarkedText(doc, "annotation", "id", "a1"), " ask @Ada Lovelace now");
});

// --- anchor mode: a stored quote holds U+FFFC, whatever the label ----------

test("anchor: textBetween gives a chip its anchor text by itself, and quotedTextAt keeps it", () => {
  const node = pmDocContentSchema.nodeFromJSON(body());
  const end = node.content.size;
  // Plain textBetween, as annotation, tag and link anchors derive a quote: a
  // hard break contributes nothing there.
  assert.equal(node.textBetween(0, end, " "), `Ask ${CHIP_ANCHOR_TEXT} nowthen ${CHIP_ANCHOR_TEXT}.`);
  // A comment quote's derivation: a hard break is a space, a chip is still its anchor text.
  assert.equal(quotedTextAt(node, 0, end), `Ask ${CHIP_ANCHOR_TEXT} now then ${CHIP_ANCHOR_TEXT}.`);
  // What a bare string leaf argument does instead, which is why quotedTextAt passes a function.
  assert.equal(node.textBetween(0, end, " ", " "), "Ask   now then  .");
  assert.equal(node.textBetween(0, end, " ", anchorLeafText("|")), `Ask ${CHIP_ANCHOR_TEXT} now|then ${CHIP_ANCHOR_TEXT}.`);
});

test("anchor: a label never reaches a quote, so a rename can't change one", () => {
  const before = pmDocContentSchema.nodeFromJSON(body());
  const renamed = pmDocContentSchema.nodeFromJSON(body(true));
  assert.equal(quotedTextAt(renamed, 0, renamed.content.size), quotedTextAt(before, 0, before.content.size));
});
