import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { pmDocContentSchema } from "../tiptap-schema";
import { MENTION, type MentionUser } from "./kinds/mention";
import { relabelChips, withChipLabels, withoutChipLabels } from "./materialize";
import { DEFAULT_CHIP_STYLES, type ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 8 — a cache column's chips carry their
// labels, and nothing else about the document changes for it.

const user = (id: string, name: string): MentionUser => ({ id, name, initials: "", slug: id, deleted: false, botOf: null });
const inputs = (name: string): ChipInputs => ({
  styles: DEFAULT_CHIP_STYLES,
  context: { [MENTION]: { u1: user("u1", name) } },
});

const chip = (iid: string, userId: string, label?: string): JSONContent => ({
  type: "entityChip",
  attrs: { kind: MENTION, iid, data: { userId }, ...(label === undefined ? {} : { label }) },
});
const doc = (...chips: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Ask " }, ...chips, { type: "text", text: "." }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: chips }] }] },
  ],
});

test("labels are written onto the chips, at any depth, and onto nothing else", () => {
  const labelled = withChipLabels(doc(chip("i1", "u1")), new Map([["i1", "@Ada"]]));
  assert.deepEqual(labelled, doc(chip("i1", "u1", "@Ada")));
});

test("a chip with no label to give is left exactly as it was", () => {
  const before = doc(chip("i1", "u1"), chip("i2", "u2", "@Stale"));
  assert.deepEqual(withChipLabels(before, new Map([["i1", "@Ada"]])), doc(chip("i1", "u1", "@Ada"), chip("i2", "u2", "@Stale")));
});

test("stripping the labels gives back what the ydoc decodes to", () => {
  const bare = doc(chip("i1", "u1"), chip("i2", "u2"));
  assert.deepEqual(withoutChipLabels(withChipLabels(bare, new Map([["i1", "@Ada"], ["i2", "@Grace"]]))), bare);
  assert.deepEqual(withoutChipLabels(bare), bare);
});

test("neither changes the document it was given", () => {
  const original = doc(chip("i1", "u1"));
  const copy = structuredClone(original);
  withoutChipLabels(withChipLabels(original, new Map([["i1", "@Ada"]])));
  assert.deepEqual(original, copy);
});

test("relabelling replaces a stale label with the current one", () => {
  const stale = doc(chip("i1", "u1", "@Ada Byron"));
  assert.deepEqual(relabelChips(stale, inputs("Ada Lovelace")), doc(chip("i1", "u1", "@Ada Lovelace")));
  // Twice is once: the refresh can run over a doc any number of times.
  assert.deepEqual(relabelChips(relabelChips(stale, inputs("Ada Lovelace")), inputs("Ada Lovelace")), doc(chip("i1", "u1", "@Ada Lovelace")));
});

test("a labelled document decodes to the same nodes as an unlabelled one, at the same positions", () => {
  const bare = pmDocContentSchema.nodeFromJSON(doc(chip("i1", "u1")));
  const labelled = pmDocContentSchema.nodeFromJSON(doc(chip("i1", "u1", "@Ada Lovelace")));
  assert.ok(labelled.eq(bare));
  assert.equal(labelled.content.size, bare.content.size);
  // And the label is gone from what the schema hands back, so it can't reach a ydoc.
  assert.deepEqual(labelled.toJSON(), bare.toJSON());
});
