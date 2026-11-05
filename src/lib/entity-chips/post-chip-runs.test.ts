import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { pmSchema } from "../tiptap-schema";
import { identityTextBetween, mapChipEdge, postChipRuns } from "./post-chip-runs";

// docs/ENTITY_CHIPS.md, step 1, item 9 — two publishes of one doc can call
// the same chip different things, and a quote holding the chip should be
// compared by who it stands for.

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const chip = (label: string, iid: string, userId: string, extra: JSONContent["marks"] = []): JSONContent =>
  text(label, [...extra, { type: "link", attrs: { href: `/authors/${userId}`, chip: { kind: "mention", iid, targets: [userId] } } }]);
const post = (...content: JSONContent[]) => pmSchema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content }] });

const BEFORE = post(text("Reviewed by "), chip("@Luke Breuer", "i1", "u1"), text(" and "), chip("@Ada", "i2", "u2"), text("."));
const AFTER = post(text("Kindly reviewed by "), chip("@L. B.", "i1", "u1"), text(" and "), chip("@Ada", "i2", "u2"), text("."));

test("a chip's label is one run, by the chip its link records", () => {
  assert.deepEqual(postChipRuns(BEFORE), [
    { from: 13, to: 25, iid: "i1", identity: "mention:u1" },
    { from: 30, to: 34, iid: "i2", identity: "mention:u2" },
  ]);
  // An ordinary link, and a link whose `chip` is not a chip, are text.
  const plain = post(text("See "), text("this", [{ type: "link", attrs: { href: "/authors/u1" } }]));
  assert.deepEqual(postChipRuns(plain), []);
  // A label split by another mark is still one chip.
  const split = post(chip("@Luke ", "i1", "u1"), chip("Breuer", "i1", "u1", [{ type: "bold" }]));
  assert.deepEqual(postChipRuns(split), [{ from: 1, to: 13, iid: "i1", identity: "mention:u1" }]);
});

test("a range holding chips whole reads the same across a relabelling, and differs when the person does", () => {
  const before = postChipRuns(BEFORE);
  const after = postChipRuns(AFTER);
  // "by <Luke> and <Ada>" in each.
  const was = identityTextBetween(BEFORE, 10, 34, before);
  assert.equal(was, "by ￼mention:u1￼ and ￼mention:u2￼");
  assert.equal(identityTextBetween(AFTER, 17, 35, after), was);
  const other = post(text("Reviewed by "), chip("@Luke Breuer", "i9", "u3"), text(" and "), chip("@Ada", "i2", "u2"), text("."));
  assert.notEqual(identityTextBetween(other, 10, 34, postChipRuns(other)), was);
});

test("a range that cuts through a label, or holds no chip, has only its text to go by", () => {
  const runs = postChipRuns(BEFORE);
  assert.equal(identityTextBetween(BEFORE, 10, 18, runs), null, "ends inside a label");
  assert.equal(identityTextBetween(BEFORE, 15, 34, runs), null, "starts inside a label");
  assert.equal(identityTextBetween(BEFORE, 1, 12, runs), null, "no chip at all");
});

test("an end on a chip's edge follows that chip into the next publish", () => {
  const before = postChipRuns(BEFORE);
  const after = postChipRuns(AFTER);
  assert.equal(mapChipEdge(25, "to", before, after), 26);
  assert.equal(mapChipEdge(13, "from", before, after), 20);
  // Not on an edge, a chip that is gone, and an id two runs share: left to the mapping.
  assert.equal(mapChipEdge(20, "to", before, after), null);
  assert.equal(mapChipEdge(25, "to", before, []), null);
  const twins = post(chip("@A", "i1", "u1"), text(" "), chip("@A", "i1", "u1"));
  assert.equal(mapChipEdge(25, "to", before, postChipRuns(twins)), null);
});
