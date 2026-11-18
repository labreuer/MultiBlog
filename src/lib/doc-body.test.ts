import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { diffBlocks, versionBlocks, type DocBody } from "./doc-body";
import { docBlocks } from "./doc-text";
import { MENTION, type MentionUser } from "./entity-chips/kinds/mention";
import { chipLabelsIn } from "./entity-chips/text";
import { DEFAULT_CHIP_STYLES, type ChipContext } from "./entity-chips/types";
import { pmDocContentSchema } from "./tiptap-schema";

// docs/FORKS.md "Sliders on the diff page" — the rule a browser builds a
// version under: its blocks only when it holds the record of every target the
// body's chips name. What it refuses is the point, since a side labelled from
// part of the records fails nothing and reads differently from the server's.

const user = (id: string, name: string, slug: string): MentionUser => ({ id, name, initials: "", slug, deleted: false, botOf: null });
const ADA = user("u1", "Ada Lovelace", "ada");
const GRACE = user("u2", "Grace Hopper", "grace");

const chip = (iid: string, kind: string, data: Record<string, unknown>): JSONContent => ({ type: "entityChip", attrs: { kind, iid, data } });
const text = (value: string): JSONContent => ({ type: "text", text: value });
const bodyOf = (...blocks: JSONContent[]): DocBody => {
  const json = { type: "doc", content: blocks };
  return { json, node: pmDocContentSchema.nodeFromJSON(json), title: "", styles: DEFAULT_CHIP_STYLES };
};

const TWO_MENTIONS = bodyOf(
  { type: "heading", attrs: { level: 2 }, content: [text("Who to ask")] },
  { type: "paragraph", content: [text("Ask "), chip("i1", MENTION, { userId: "u1" }), text(" and "), chip("i2", MENTION, { userId: "u2" }), text(".")] },
);

test("a body with no chip is built from no records", () => {
  const built = versionBlocks(bodyOf({ type: "paragraph", content: [text("Plain.")] }), {});
  assert.deepEqual(built, { ok: true, blocks: [{ text: "Plain.", type: "paragraph", heading: false }] });
});

test("with every record, the blocks are the ones the server's own steps give", () => {
  const context: ChipContext = { [MENTION]: { u1: ADA, u2: GRACE } };
  const built = versionBlocks(TWO_MENTIONS, context);
  assert.deepEqual(built, {
    ok: true,
    blocks: [
      { text: "Who to ask", type: "heading", heading: true },
      { text: "Ask @Ada Lovelace and @Grace Hopper.", type: "paragraph", heading: false },
    ],
  });
  // `stateOf`'s two steps, src/lib/doc-state.ts, and `loadSide`'s, src/lib/diff-pair.ts.
  const labels = chipLabelsIn(TWO_MENTIONS.node, { styles: TWO_MENTIONS.styles, context });
  assert.deepEqual(built.ok && built.blocks, diffBlocks(docBlocks(TWO_MENTIONS.node, labels)));
});

test("a record short is a refusal that names it, never blocks with an unknown person in them", () => {
  assert.deepEqual(versionBlocks(TWO_MENTIONS, { [MENTION]: { u1: ADA } }), { ok: false, reason: "missing", missing: { [MENTION]: ["u2"] } });
  assert.deepEqual(versionBlocks(TWO_MENTIONS, {}), { ok: false, reason: "missing", missing: { [MENTION]: ["u1", "u2"] } });
  // A context whose entry for the kind isn't a record holds nothing.
  assert.deepEqual(versionBlocks(TWO_MENTIONS, { [MENTION]: null }), { ok: false, reason: "missing", missing: { [MENTION]: ["u1", "u2"] } });
  // A record under another kind's name is not this kind's.
  assert.equal(versionBlocks(TWO_MENTIONS, { citation: { u1: ADA, u2: GRACE } }).ok, false);
});

test("a chip of a kind this build doesn't know is a refusal, whatever records are held", () => {
  const body = bodyOf({ type: "paragraph", content: [chip("i1", MENTION, { userId: "u1" }), chip("i2", "a-later-kind", { id: "x" })] });
  assert.deepEqual(versionBlocks(body, { [MENTION]: { u1: ADA } }), { ok: false, reason: "unknown-kind" });
});

test("a chip its own kind refuses names no record, and is built as the server shows it", () => {
  const body = bodyOf({ type: "paragraph", content: [text("By "), chip("i1", MENTION, { userId: 7 }), text(".")] });
  const built = versionBlocks(body, {});
  assert.equal(built.ok, true);
  const labels = chipLabelsIn(body.node, { styles: body.styles, context: {} });
  assert.deepEqual(built.ok && built.blocks, diffBlocks(docBlocks(body.node, labels)));
});
