import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { pmCommentContentSchema, pmDocContentSchema } from "./tiptap-schema";
import { currentOrderedListType, setOrderedListType } from "./ordered-list-style";

// docs/TIPTAP.md "A numbered list's style is its `type`".

const schema = pmDocContentSchema;
const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const item = (text: string, ...rest: PMNode[]) => schema.nodes.listItem.create(null, [para(text), ...rest]);
const ol = (type: string | null, ...items: PMNode[]) => schema.nodes.orderedList.create({ start: 1, type }, items);

// "one" > ["x", "y"] nested, then "two"; and a paragraph after the list.
function nestedDoc(outer: string | null, inner: string | null) {
  return schema.nodes.doc.create(null, [ol(outer, item("one", ol(inner, item("x"), item("y"))), item("two")), para("after")]);
}

function stateAt(doc: PMNode, text: string) {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos + 1;
  });
  assert.ok(at > 0, text);
  return EditorState.create({ doc, selection: TextSelection.create(doc, at) });
}

function listTypes(doc: PMNode): (string | null)[] {
  const types: (string | null)[] = [];
  doc.descendants((node) => {
    if (node.type.name === "orderedList") types.push(node.attrs.type);
  });
  return types;
}

test("the current style is the innermost list's, and undefined outside every list", () => {
  const doc = nestedDoc(null, "a");
  assert.equal(currentOrderedListType(stateAt(doc, "one")), null);
  assert.equal(currentOrderedListType(stateAt(doc, "x")), "a");
  assert.equal(currentOrderedListType(stateAt(doc, "two")), null);
  assert.equal(currentOrderedListType(stateAt(doc, "after")), undefined);
});

test("a pasted type of \"1\" reads as plain numbers", () => {
  assert.equal(currentOrderedListType(stateAt(nestedDoc("1", null), "one")), null);
});

test("setting the style changes only the innermost list around the caret", () => {
  const inner = stateAt(nestedDoc(null, null), "x");
  const tr = inner.tr;
  assert.equal(setOrderedListType(tr, "i"), true);
  assert.deepEqual(listTypes(tr.doc), [null, "i"]);

  const outer = stateAt(nestedDoc(null, "a"), "two");
  const tr2 = outer.tr;
  assert.equal(setOrderedListType(tr2, "A"), true);
  assert.deepEqual(listTypes(tr2.doc), ["A", "a"]);
});

test("back to plain numbers stores no type, and start is kept", () => {
  const doc = schema.nodes.doc.create(null, [schema.nodes.orderedList.create({ start: 4, type: "I" }, [item("one")])]);
  const tr = stateAt(doc, "one").tr;
  assert.equal(setOrderedListType(tr, null), true);
  const list = tr.doc.firstChild!;
  assert.equal(list.attrs.type, null);
  assert.equal(list.attrs.start, 4);
});

test("outside a numbered list nothing changes and the answer is false", () => {
  const tr = stateAt(nestedDoc(null, null), "after").tr;
  assert.equal(setOrderedListType(tr, "a"), false);
  assert.equal(tr.docChanged, false);
});

test("the comment schema's numbered list carries the same attribute", () => {
  assert.ok("type" in pmCommentContentSchema.nodes.orderedList.spec.attrs!);
  assert.ok("type" in schema.nodes.orderedList.spec.attrs!);
});
