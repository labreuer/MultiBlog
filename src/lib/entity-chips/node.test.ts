import { test } from "node:test";
import assert from "node:assert/strict";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { pmDocContentSchema as schema } from "../tiptap-schema";
import { conformChipAttrs, newChipIid, repairChipIids } from "./node";
import { chipsIn } from "./renderings";
import { ENTITY_CHIP } from "./types";

// docs/ENTITY_CHIPS.md, step 1, items 2 and 3 — what may be stored as a chip,
// and the instance-id repair.

const mention = (iid: string, userId = "luke") =>
  schema.nodes[ENTITY_CHIP].create({ kind: "mention", iid, data: { userId } });
const para = (...content: (string | PMNode)[]) =>
  schema.nodes.paragraph.create(
    null,
    content.map((part) => (typeof part === "string" ? schema.text(part) : part)),
  );
const stateOf = (...blocks: PMNode[]) => EditorState.create({ doc: schema.nodes.doc.create(null, blocks) });

/** Applies `tr` and then the repair it calls for, as the plugin's appendTransaction would. */
function applyWithRepair(state: EditorState, tr: Transaction): EditorState {
  const next = state.apply(tr);
  const repair = repairChipIids([tr], next);
  return repair ? next.apply(repair) : next;
}

const iids = (state: EditorState) => chipsIn(state.doc).map((chip) => chip.iid);

test("a known kind's fields go through its validator; an unknown kind's are kept as they are", () => {
  assert.deepEqual(conformChipAttrs({ kind: "mention", iid: "i1", data: { userId: "luke", label: "x" } }), {
    kind: "mention",
    iid: "i1",
    data: { userId: "luke" },
  });
  assert.equal(conformChipAttrs({ kind: "mention", iid: "i1", data: { user: "luke" } }), null);
  assert.deepEqual(conformChipAttrs({ kind: "future", iid: "i1", data: { anything: [1, 2] } }), {
    kind: "future",
    iid: "i1",
    data: { anything: [1, 2] },
  });
});

test("what is not a chip at all is refused", () => {
  for (const attrs of [
    { kind: "", iid: "i1", data: {} },
    { kind: null, iid: "i1", data: {} },
    { kind: "k".repeat(65), iid: "i1", data: {} },
    { kind: "future", iid: "i1", data: [] },
    { kind: "future", iid: "i1", data: "text" },
    { kind: "future", iid: "i1", data: { blob: "x".repeat(5000) } },
  ]) {
    assert.equal(conformChipAttrs(attrs), null, JSON.stringify(attrs).slice(0, 60));
  }
});

test("a missing or oversized instance id is stored empty, for the repair to fill", () => {
  assert.equal(conformChipAttrs({ kind: "mention", iid: undefined, data: { userId: "luke" } })?.iid, "");
  assert.equal(conformChipAttrs({ kind: "mention", iid: "i".repeat(65), data: { userId: "luke" } })?.iid, "");
});

test("fresh instance ids are short and don't repeat", () => {
  const made = new Set(Array.from({ length: 2000 }, newChipIid));
  assert.equal(made.size, 2000);
  for (const iid of made) assert.match(iid, /^[0-9a-z]{14}$/);
});

test("a chip inserted with no instance id gets one", () => {
  const state = stateOf(para("Ask "));
  const next = applyWithRepair(state, state.tr.insert(5, mention("")));
  assert.equal(iids(next).length, 1);
  assert.match(iids(next)[0], /^[0-9a-z]{14}$/);
});

test("a pasted copy gets a new id and the original keeps its own, whichever comes first", () => {
  const state = stateOf(para("a ", mention("keep"), " b"));
  const copy = new Slice(Fragment.from(mention("keep")), 0, 0);

  // Pasted after the original.
  const after = applyWithRepair(state, state.tr.replace(6, 6, copy));
  assert.equal(iids(after)[0], "keep");
  assert.notEqual(iids(after)[1], "keep");

  // Pasted before it: the original is now the later of the two, and still keeps its id.
  const before = applyWithRepair(state, state.tr.replace(1, 1, copy));
  assert.notEqual(iids(before)[0], "keep");
  assert.equal(iids(before)[1], "keep");
});

test("two copies pasted at once: the first keeps the id when no original remains", () => {
  const state = stateOf(para("a b"));
  const two = new Slice(Fragment.from([mention("same"), mention("same")]), 0, 0);
  const next = applyWithRepair(state, state.tr.replace(2, 2, two));
  assert.equal(iids(next)[0], "same");
  assert.notEqual(iids(next)[1], "same");
});

test("cut and paste keeps the id", () => {
  const state = stateOf(para("a ", mention("moved"), " b"), para("c"));
  const cut = state.apply(state.tr.delete(3, 4));
  assert.deepEqual(iids(cut), []);
  const pasted = applyWithRepair(cut, cut.tr.insert(cut.doc.content.size - 1, mention("moved")));
  assert.deepEqual(iids(pasted), ["moved"]);
});

test("ordinary typing, and a duplicate this client didn't insert, call for no repair", () => {
  const state = stateOf(para("a ", mention("same"), mention("same")));
  const typed = state.tr.insertText("x", 1);
  assert.equal(repairChipIids([typed], state.apply(typed)), null);
});
