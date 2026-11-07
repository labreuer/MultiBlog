import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { pmDocContentSchema } from "../tiptap-schema";
import { chipsIn } from "./renderings";
import { chipItemIds, iidFromItem, sharedIidFixes } from "./shared-iids";

// docs/ENTITY_CHIPS.md, step 1, item 3 — a shared instance id is repaired
// with an id every replica derives alike.

const chip = (iid: string): JSONContent => ({ type: "entityChip", attrs: { kind: "mention", iid, data: { userId: "u1" } } });
const text = (value: string): JSONContent => ({ type: "text", text: value });

const DOC = pmDocContentSchema.nodeFromJSON({
  type: "doc",
  content: [
    { type: "paragraph", content: [text("Ask "), chip("dup"), text(" or "), chip("other"), text(".")] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [chip("dup"), text(" again, and "), chip("dup")] }] }] },
  ],
});

function ydocOf(): Y.Doc {
  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(DOC, ydoc.getXmlFragment("default"));
  return ydoc;
}

test("the chips' Yjs items are found in document order, nested ones included", () => {
  const ydoc = ydocOf();
  const items = chipItemIds(ydoc.getXmlFragment("default"));
  assert.equal(items.length, 4);
  assert.equal(new Set(items.map(iidFromItem)).size, 4, "each chip is its own item");
  assert.ok(items.every((item) => item.client === ydoc.clientID));
});

test("each chip sharing an earlier one's id gets its item's id, and the first keeps its own", () => {
  const ydoc = ydocOf();
  const items = chipItemIds(ydoc.getXmlFragment("default"));
  const chips = chipsIn(DOC);
  const fixes = sharedIidFixes(chips, items);
  assert.deepEqual(
    fixes.map((fix) => fix.pos),
    [chips[2].pos, chips[3].pos],
  );
  assert.deepEqual(
    fixes.map((fix) => fix.iid),
    [iidFromItem(items[2]), iidFromItem(items[3])],
  );
  assert.match(fixes[0].iid, /^y[0-9a-z]+\.[0-9a-z]+$/);
  assert.deepEqual(sharedIidFixes(chips.slice(0, 2), items), [], "nothing shared, nothing to fix");
});

test("a replica that received the document derives the same ids as the one that wrote it", () => {
  const origin = ydocOf();
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(origin));
  assert.notEqual(replica.clientID, origin.clientID);
  const chips = chipsIn(DOC);
  assert.deepEqual(
    sharedIidFixes(chips, chipItemIds(replica.getXmlFragment("default"))),
    sharedIidFixes(chips, chipItemIds(origin.getXmlFragment("default"))),
  );
});
