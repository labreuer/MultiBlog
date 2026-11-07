import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { CHIP_ANCHOR_TEXT } from "../entity-chips/types";
import { pmDocContentSchema } from "../tiptap-schema";
import { captureAnchorInNode } from "./capture-node";
import {
  chipPositions,
  chipRecordsBetween,
  edgeChipRecords,
  parseChipRecords,
  quoteWithChipLabels,
  quoteWithEdgeChips,
  rangeWithEdgeChips,
  recordIdentities,
  relabelChipRecords,
} from "./chips";
import { anchorHolds, resolveAnchorInDoc } from "./resolve";
import { deriveDocRangeSelector, parseSelector, shownQuote } from "./selector";

// docs/ENTITY_CHIPS.md, step 1, item 11 — the chip record: written with the
// anchor, from the node the quote came from, and enough to show the quote
// with its labels where no ydoc is open.

const chip = (iid: string, userId: string): JSONContent => ({ type: "entityChip", attrs: { kind: "mention", iid, data: { userId } } });
const text = (value: string): JSONContent => ({ type: "text", text: value });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const docOf = (...blocks: JSONContent[]) => pmDocContentSchema.nodeFromJSON({ type: "doc", content: blocks });

// "Reviewed by <Ada> and <Grace>." / "<Ada> signed."
const DOC = docOf(para(text("Reviewed by "), chip("i1", "u1"), text(" and "), chip("i2", "u2"), text(".")), para(chip("i3", "u1"), text(" signed.")));
const LABELS = new Map([
  ["i1", "@Ada"],
  ["i2", "@Grace"],
  ["i3", "@Ada"],
]);
const C = CHIP_ANCHOR_TEXT;

test("a record's offset is where its chip's U+FFFC is in the range's own text", () => {
  // From "by" to the end of the first paragraph.
  const from = 1 + "Reviewed ".length;
  const to = DOC.child(0).nodeSize - 1;
  const quoted = DOC.textBetween(from, to, " ");
  assert.equal(quoted, `by ${C} and ${C}.`);
  const records = chipRecordsBetween(DOC, from, to, LABELS);
  assert.deepEqual(records, [
    { at: 3, kind: "mention", iid: "i1", data: { userId: "u1" }, label: "@Ada" },
    { at: 9, kind: "mention", iid: "i2", data: { userId: "u2" }, label: "@Grace" },
  ]);
  for (const record of records) assert.equal(quoted[record.at], C);
  assert.equal(quoteWithChipLabels(quoted, records), "by @Ada and @Grace.");
});

test("a range spanning a block boundary counts the separator before a chip that opens the next block", () => {
  const from = DOC.child(0).nodeSize - 2; // the "."
  const to = DOC.content.size - 1;
  const quoted = DOC.textBetween(from, to, " ");
  assert.equal(quoted, `. ${C} signed.`);
  const records = chipRecordsBetween(DOC, from, to);
  assert.deepEqual(records, [{ at: 2, kind: "mention", iid: "i3", data: { userId: "u1" } }]);
  // No label was given at the write, so none is claimed.
  assert.equal(quoteWithChipLabels(quoted, records), ". […] signed.");
  assert.equal(quoteWithChipLabels(quoted, records, LABELS), ". @Ada signed.");
});

test("a chip half outside the range is not in it, and a range with no chip has no record", () => {
  assert.deepEqual(chipRecordsBetween(DOC, 1, 1 + "Reviewed by ".length), []);
  assert.equal(deriveDocRangeSelector(DOC, 1, 9).chips, undefined);
});

test("the selector keeps the records through a round trip, and shows the quote with them", () => {
  const from = 1 + "Reviewed ".length;
  const to = DOC.child(0).nodeSize - 1;
  const selector = deriveDocRangeSelector(DOC, from, to, LABELS);
  assert.equal(selector.chips?.length, 2);
  const parsed = parseSelector("DOC_RANGE", JSON.parse(JSON.stringify(selector)));
  assert.deepEqual(parsed, { kind: "DOC_RANGE", selector });
  assert.equal(shownQuote({ quotedText: DOC.textBetween(from, to, " "), selector: parsed }), "by @Ada and @Grace.");
  assert.equal(shownQuote({ quotedText: "plain", selector: null }), "plain");
});

test("capture writes the records from the node the quote came from, at the range it resolved", () => {
  const from = 1 + "Reviewed ".length;
  const to = from + `by ${C}`.length;
  // Offsets two to the right of the passage: re-found by its text.
  const captured = captureAnchorInNode(DOC, from + 2, to + 2, `by ${C}`, LABELS);
  assert.deepEqual(captured && { from: captured.from, to: captured.to, quotedText: captured.quotedText }, { from, to, quotedText: `by ${C}` });
  assert.deepEqual(captured?.selector.chips, [{ at: 3, kind: "mention", iid: "i1", data: { userId: "u1" }, label: "@Ada" }]);
});

test("a stored list is parsed, never cast: anything malformed reads as no record", () => {
  const good = [{ at: 0, kind: "mention", iid: "i1", data: { userId: "u1" }, label: "@Ada", extra: 1 }];
  assert.deepEqual(parseChipRecords(good), [{ at: 0, kind: "mention", iid: "i1", data: { userId: "u1" }, label: "@Ada" }]);
  for (const bad of [
    null,
    "x",
    {},
    [{ at: -1, kind: "mention", iid: "i1", data: {} }],
    [{ at: 0.5, kind: "mention", iid: "i1", data: {} }],
    [{ at: 0, kind: 3, iid: "i1", data: {} }],
    [{ at: 0, kind: "mention", iid: "i1", data: [] }],
    [{ at: 0, kind: "mention", iid: "i1", data: {}, label: 3 }],
    [good[0], null],
  ]) {
    assert.deepEqual(parseChipRecords(bad), [], JSON.stringify(bad));
  }
});

test("a record that doesn't point at a chip's place is skipped, not applied", () => {
  // The list describes some other text: the quote is shown as it is.
  assert.equal(quoteWithChipLabels("no chip here", [{ at: 3, kind: "mention", iid: "i1", data: {}, label: "@Ada" }]), "no chip here");
  // Two records at one place: the first stands.
  const twice = [
    { at: 0, kind: "mention", iid: "i1", data: {}, label: "@Ada" },
    { at: 0, kind: "mention", iid: "i2", data: {}, label: "@Grace" },
  ];
  assert.equal(quoteWithChipLabels(`${C}!`, twice), "@Ada!");
});

test("identities name the entity, whatever the instance or label; relabelling goes by instance", () => {
  const records = chipRecordsBetween(DOC, 0, DOC.content.size, LABELS);
  assert.deepEqual(recordIdentities(records), ["mention:u1", "mention:u2", "mention:u1"]);
  const renamed = relabelChipRecords(records, new Map([["i1", "@Ada Lovelace"]]));
  assert.deepEqual(
    renamed.map((record) => record.label),
    ["@Ada Lovelace", "@Grace", "@Ada"],
  );
});

// --- the resolvers: identity, then instance --------------------------------

const BY = `by ${C}`;
const byRecord = (iid: string, userId: string) => [{ at: 3, kind: "mention", iid, data: { userId } }];

test("a passage whose chip now stands for someone else no longer resolves, though its text is the same", () => {
  const from = 1 + "Reviewed ".length;
  const to = from + BY.length;
  assert.deepEqual(resolveAnchorInDoc(DOC, from, to, BY, undefined, byRecord("i1", "u1")), { from, to });
  // The same words, the chip a different person: the offsets still read "by ￼".
  const swapped = docOf(para(text("Reviewed by "), chip("i9", "u2"), text(".")));
  assert.equal(swapped.textBetween(from, to, " "), BY);
  assert.equal(resolveAnchorInDoc(swapped, from, to, BY, undefined, byRecord("i1", "u1")), null);
  assert.equal(anchorHolds(swapped, from, to, BY, byRecord("i1", "u1")), false);
  // An anchor with no record goes by its text, as one written before records did.
  assert.deepEqual(resolveAnchorInDoc(swapped, from, to, BY), { from, to });
  assert.equal(anchorHolds(swapped, from, to, BY), true);
});

test("a rename changes nothing an anchor compares", () => {
  // Labels are not in the document at all; the same chip under another name is the same passage.
  const from = 1 + "Reviewed ".length;
  const record = [{ ...byRecord("i1", "u1")[0], label: "@An Old Name" }];
  assert.deepEqual(resolveAnchorInDoc(DOC, from, from + BY.length, BY, undefined, record), { from, to: from + BY.length });
});

test("of several passages with the same words, the one naming the recorded person is meant", () => {
  // "Seen by <Grace>." / "Seen by <Ada>." — stale offsets, so the text is searched for.
  const two = docOf(para(text("Seen by "), chip("g", "u2"), text(".")), para(text("Seen by "), chip("a", "u1"), text(".")));
  const second = two.child(0).nodeSize + 1 + "Seen ".length;
  assert.equal(resolveAnchorInDoc(two, 0, 4, BY), null, "ambiguous by text alone");
  assert.deepEqual(resolveAnchorInDoc(two, 0, 4, BY, undefined, byRecord("x", "u1")), { from: second, to: second + BY.length });
});

test("of several naming the same person, the recorded instance is meant, and none is when it is gone", () => {
  const two = docOf(para(text("Seen by "), chip("a1", "u1"), text(".")), para(text("Seen by "), chip("a2", "u1"), text(".")));
  const second = two.child(0).nodeSize + 1 + "Seen ".length;
  assert.deepEqual(resolveAnchorInDoc(two, 0, 4, BY, undefined, byRecord("a2", "u1")), { from: second, to: second + BY.length });
  assert.equal(resolveAnchorInDoc(two, 0, 4, BY, undefined, byRecord("gone", "u1")), null);
  // One left: its words and its person are enough.
  const one = docOf(para(text("Seen by "), chip("a2", "u1"), text(".")));
  assert.deepEqual(resolveAnchorInDoc(one, 0, 4, BY, undefined, byRecord("gone", "u1")), { from: 1 + "Seen ".length, to: 1 + "Seen ".length + BY.length });
});

test("a quote that is a chip alone resolves by instance, wherever the chip went", () => {
  const lone = [{ at: 0, kind: "mention", iid: "i3", data: { userId: "u1" } }];
  const at = DOC.child(0).nodeSize + 1;
  assert.equal(DOC.textBetween(at, at + 1, " "), C);
  // Offsets that land on another chip of the same person: not this anchor's.
  const i1 = 1 + "Reviewed by ".length;
  assert.equal(anchorHolds(DOC, i1, i1 + 1, C, lone), false);
  assert.deepEqual(resolveAnchorInDoc(DOC, i1, i1 + 1, C, undefined, lone), { from: at, to: at + 1 });
  // The chip deleted: another mention of the same person is not what was annotated.
  const without = docOf(para(text("Reviewed by "), chip("i1", "u1"), text(".")));
  assert.equal(resolveAnchorInDoc(without, i1, i1 + 1, C, undefined, lone), null);
  // Two chips sharing an id is a state the editor repairs; until it has, neither is picked.
  const twins = docOf(para(chip("i3", "u1"), text(" and "), chip("i3", "u1")));
  assert.equal(resolveAnchorInDoc(twins, 9, 10, C, undefined, lone), null);
});

// --- a marked passage's edge chips -----------------------------------------

test("the chips a mark can't cover are the ones outside the passage's text", () => {
  // "<Ada> said <Grace>": one before the text, one after.
  const around = docOf(para(chip("a", "u1"), text(" said "), chip("g", "u2")));
  assert.deepEqual(
    edgeChipRecords(around, 1, around.content.size - 1).map((record) => record.iid),
    ["a", "g"],
  );
  // "<Ada> <Grace> said": the second is between marked runs, inside the mark's hull.
  const inside = docOf(para(chip("a", "u1"), text(" "), chip("g", "u2"), text(" said")));
  assert.deepEqual(
    edgeChipRecords(inside, 1, inside.content.size - 1).map((record) => record.iid),
    ["a"],
  );
  // A chip alone, and two with nothing between them.
  const alone = docOf(para(text("Ask "), chip("a", "u1"), chip("g", "u2"), text(".")));
  assert.deepEqual(
    edgeChipRecords(alone, 5, 7).map((record) => [record.iid, record.at]),
    [
      ["a", 0],
      ["g", 1],
    ],
  );
  assert.deepEqual(edgeChipRecords(alone, 1, 5), []);
});

test("a marked passage reads with its edge chips' labels, less any the doc no longer holds", () => {
  const edges = [
    { at: 0, kind: "mention", iid: "a", data: { userId: "u1" } },
    { at: 7, kind: "mention", iid: "g", data: { userId: "u2" } },
  ];
  const labels = new Map([
    ["a", "@Ada"],
    ["g", "@Grace"],
  ]);
  assert.equal(quoteWithEdgeChips(" said ", edges, labels), "@Ada said @Grace");
  assert.equal(quoteWithEdgeChips(" said ", edges, new Map([["g", "@Grace"]])), " said @Grace");
  // A chip alone, gone: no passage.
  assert.equal(quoteWithEdgeChips("", [edges[0]], new Map()), "");
  assert.equal(quoteWithEdgeChips("", [edges[0]], labels), "@Ada");
});

test("a marked passage's range is its mark's hull, stretched over the edge chips still beside it", () => {
  const around = docOf(para(chip("a", "u1"), text(" said "), chip("g", "u2")), para(text("Elsewhere.")));
  const edges = edgeChipRecords(around, 1, around.child(0).nodeSize - 1);
  const hull = { from: 2, to: 8 };
  assert.deepEqual(rangeWithEdgeChips(around, hull, edges, chipPositions(around)), { from: 1, to: 9 });
  // No marked text at all: the chips' own span.
  const lone = docOf(para(text("Ask "), chip("a", "u1"), text(".")));
  assert.deepEqual(rangeWithEdgeChips(lone, null, [{ at: 0, kind: "mention", iid: "a", data: {} }], chipPositions(lone)), { from: 5, to: 6 });
  assert.equal(rangeWithEdgeChips(lone, null, [{ at: 0, kind: "mention", iid: "gone", data: {} }], chipPositions(lone)), null);
  // An edge chip moved to another paragraph keeps its id, and is not chased.
  const moved = docOf(para(text(" said "), chip("g", "u2")), para(chip("a", "u1"), text(" is down here.")));
  assert.deepEqual(rangeWithEdgeChips(moved, { from: 1, to: 7 }, edges, chipPositions(moved)), { from: 1, to: 8 });
});

test("an instance id two chips share finds neither", () => {
  const twins = docOf(para(chip("a", "u1"), text(" and "), chip("a", "u1"), text(" and "), chip("b", "u2")));
  const at = chipPositions(twins);
  assert.equal(at("a"), undefined);
  assert.equal(at("b"), 13);
  assert.equal(at("nobody"), undefined);
});
