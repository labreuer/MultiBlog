import { test } from "node:test";
import assert from "node:assert/strict";
import { pmAnnotationContentSchema, pmDocContentSchema as schema } from "../tiptap-schema";
import {
  chipRenderings,
  chipsIn,
  chipsInJSON,
  chipTargets,
  PENDING_CHIP,
  renderingsByIid,
  UNKNOWN_CHIP,
} from "./renderings";
import { CHIP_ANCHOR_TEXT, ENTITY_CHIP, type ChipContext } from "./types";
import { UNKNOWN_PERSON } from "./kinds/mention";

// docs/ENTITY_CHIPS.md, step 1 — the rendering function and the node's text.

const chip = (kind: string, iid: string, data: Record<string, unknown>) =>
  schema.nodes[ENTITY_CHIP].create({ kind, iid, data });
const mention = (iid: string, userId: string, form?: string) => chip("mention", iid, form ? { userId, form } : { userId });
const para = (...content: (string | ReturnType<typeof chip>)[]) =>
  schema.nodes.paragraph.create(
    null,
    content.map((part) => (typeof part === "string" ? schema.text(part) : part)),
  );
const docOf = (...blocks: ReturnType<typeof para>[]) => schema.nodes.doc.create(null, blocks);

const context: ChipContext = {
  mention: {
    luke: { id: "luke", name: "Luke Breuer", initials: "LB", slug: "luke-breuer", deleted: false, botOf: null },
    andrew: { id: "andrew", name: "Andrew Stone", initials: "AS", slug: "andrew-stone", deleted: false, botOf: null },
  },
};

const doc = docOf(
  para("Ask ", mention("i1", "luke"), " and ", mention("i2", "andrew"), "."),
  para(chip("citation-from-the-future", "i3", { items: [{ refId: "r1" }] }), " then ", mention("i4", "nobody")),
);

test("chips are collected in doc order, with their positions", () => {
  const chips = chipsIn(doc);
  assert.deepEqual(
    chips.map((c) => [c.iid, c.kind]),
    [
      ["i1", "mention"],
      ["i2", "mention"],
      ["i3", "citation-from-the-future"],
      ["i4", "mention"],
    ],
  );
  for (const c of chips) assert.equal(doc.nodeAt(c.pos)?.attrs.iid, c.iid);
});

test("the JSON walk finds the same chips as the node walk", () => {
  assert.deepEqual(
    chipsInJSON(doc.toJSON()).map(({ kind, iid, data }) => ({ kind, iid, data })),
    chipsIn(doc).map(({ kind, iid, data }) => ({ kind, iid, data })),
  );
});

test("each status, and a chip kind this build doesn't know", () => {
  const chips = chipsIn(doc);
  const renderings = chipRenderings(chips, {}, context);
  assert.deepEqual(renderings, [
    { label: "@Luke Breuer", href: "/authors/luke-breuer", postHref: "/authors/luke-breuer", status: "live" },
    { label: "@Andrew Stone", href: "/authors/andrew-stone", postHref: "/authors/andrew-stone", status: "live" },
    UNKNOWN_CHIP,
    { label: UNKNOWN_PERSON, href: null, postHref: null, status: "unknown" },
  ]);
});

test("a doc's style reaches its kind, and a missing context renders every target unknown", () => {
  const chips = chipsIn(doc);
  assert.equal(chipRenderings(chips, { mention: { form: "initials" } }, context)[0].label, "LB");
  assert.equal(chipRenderings(chips, {}, {})[0].label, UNKNOWN_PERSON);
});

test("a chip whose fields its kind refuses keeps the placeholder", () => {
  const bad = docOf(para(chip("mention", "i1", { user: "luke" }), mention("i2", "luke")));
  assert.deepEqual(
    chipRenderings(chipsIn(bad), {}, context).map((r) => r.label),
    [UNKNOWN_CHIP.label, "@Luke Breuer"],
  );
});

test("renderings by instance id: the earlier of two chips sharing an id stands for both", () => {
  const twins = docOf(para(mention("same", "luke"), mention("same", "andrew")));
  const chips = chipsIn(twins);
  const byIid = renderingsByIid(chips, chipRenderings(chips, {}, context));
  assert.equal(byIid.size, 1);
  assert.equal(byIid.get("same")?.label, "@Luke Breuer");
});

test("the targets a context loader is asked for, per chip kind, each once", () => {
  const twice = docOf(para(mention("i1", "luke"), mention("i2", "luke"), mention("i3", "andrew")));
  assert.deepEqual(chipTargets(chipsIn(twice)), { mention: ["luke", "andrew"] });
  assert.deepEqual(chipTargets(chipsIn(doc)), { mention: ["luke", "andrew", "nobody"] });
});

test("a chip's anchor text is U+FFFC in every textBetween, whatever its label", () => {
  assert.equal(doc.textBetween(0, doc.content.size, " "), `Ask ${CHIP_ANCHOR_TEXT} and ${CHIP_ANCHOR_TEXT}. ${CHIP_ANCHOR_TEXT} then ${CHIP_ANCHOR_TEXT}`);
  assert.equal(doc.firstChild?.textContent, `Ask ${CHIP_ANCHOR_TEXT} and ${CHIP_ANCHOR_TEXT}.`);
  assert.equal(CHIP_ANCHOR_TEXT.length, 1);
});

test("a chip is one position wide, a leaf, and carries no marks' worth of content", () => {
  const node = mention("i1", "luke");
  assert.equal(node.nodeSize, 1);
  assert.equal(node.isLeaf, true);
  assert.equal(node.isAtom, true);
  assert.equal(node.isInline, true);
});

test("an annotation body's schema has the node too", () => {
  assert.ok(pmAnnotationContentSchema.nodes[ENTITY_CHIP]);
  const body = pmAnnotationContentSchema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: ENTITY_CHIP, attrs: { kind: "mention", iid: "i1", data: { userId: "luke" } } }] },
    ],
  });
  assert.equal(chipsIn(body).length, 1);
});

test("a target the browser is still asking about shows a placeholder, not its kind's unknown form", () => {
  const chips = chipsIn(doc);
  const waiting = chipRenderings(chips, {}, context, { mention: ["nobody"] });
  assert.deepEqual(waiting[3], PENDING_CHIP);
  // Only chips naming that target wait; the rest are as they were.
  assert.equal(waiting[0].label, "@Luke Breuer");
  // Once it is answered and still absent, the kind says so.
  assert.equal(chipRenderings(chips, {}, context)[3].label, UNKNOWN_PERSON);
});
