import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { pmDocContentSchema as schema } from "./tiptap-schema";
import { indentTarget, sinkListItemBulletFirst } from "./indent-extension";

// docs/TIPTAP.md "Indent and outdent follow the caret": the nearer of a list
// item and a quote decides, and a quote is what a bare paragraph gets.

const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const li = (...content: PMNode[]) => schema.nodes.listItem.create(null, content);
const ul = (...items: PMNode[]) => schema.nodes.bulletList.create(null, items);
const quote = (...content: PMNode[]) => schema.nodes.blockquote.create(null, content);

const doc = schema.nodes.doc.create(null, [
  para("plain"),
  ul(li(para("item"))),
  quote(para("quoted")),
  quote(ul(li(para("list in quote")))),
  ul(li(para("lead"), quote(para("quote in list")))),
]);

function targetAt(text: string) {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos + 1;
  });
  assert.ok(at > 0, text);
  return indentTarget(doc.resolve(at));
}

test("the nearer of a list item and a quote decides, and a bare paragraph gets a quote", () => {
  assert.equal(targetAt("plain"), "blockquote");
  assert.equal(targetAt("item"), "listItem");
  assert.equal(targetAt("quoted"), "blockquote");
  assert.equal(targetAt("list in quote"), "listItem");
  assert.equal(targetAt("quote in list"), "blockquote");
});

// docs/TIPTAP.md "Indent and outdent follow the caret": a new level under a
// numbered list starts as bullets; an existing level below is joined, as
// sinkListItem joins it.

const ol = (type: string | null, ...items: PMNode[]) => schema.nodes.orderedList.create({ start: 1, type }, items);

// The doc's lists, outermost first, as "kind[:type](item texts)".
function shape(node: PMNode): string[] {
  const out: string[] = [];
  node.descendants((child) => {
    if (child.type.name === "bulletList" || child.type.name === "orderedList") {
      const items: string[] = [];
      child.forEach((item) => items.push(item.firstChild?.textContent ?? ""));
      out.push(`${child.type.name}${child.attrs.type ? `:${child.attrs.type}` : ""}(${items.join(",")})`);
    }
  });
  return out;
}

function sinkAt(start: PMNode, text: string) {
  let at = -1;
  start.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos + 1;
  });
  assert.ok(at > 0, text);
  const state = EditorState.create({ doc: start, selection: TextSelection.create(start, at) });
  let result: PMNode | null = null;
  const ok = sinkListItemBulletFirst(schema.nodes.listItem)(state, (tr) => {
    result = tr.doc;
  });
  return { ok, doc: result as PMNode | null };
}

const wrap = (...blocks: PMNode[]) => schema.nodes.doc.create(null, blocks);

test("indenting out of a numbered list starts the new level as bullets", () => {
  const { ok, doc: out } = sinkAt(wrap(ol(null, li(para("one")), li(para("two")), li(para("three")))), "two");
  assert.equal(ok, true);
  assert.deepEqual(shape(out!), ["orderedList(one,three)", "bulletList(two)"]);
  out!.check();
});

test("indenting under an item that already has bullets joins them", () => {
  const start = wrap(ol(null, li(para("one"), ul(li(para("x")))), li(para("two"))));
  const { doc: out } = sinkAt(start, "two");
  assert.deepEqual(shape(out!), ["orderedList(one)", "bulletList(x,two)"]);
  out!.check();
});

test("indenting under an item with a numbered level joins it, in that level's style", () => {
  const start = wrap(ol(null, li(para("one"), ol("a", li(para("x")))), li(para("two"))));
  const { doc: out } = sinkAt(start, "two");
  assert.deepEqual(shape(out!), ["orderedList(one)", "orderedList:a(x,two)"]);
});

test("a bullet list's new level is bullets, as before", () => {
  const { doc: out } = sinkAt(wrap(ul(li(para("one")), li(para("two")))), "two");
  assert.deepEqual(shape(out!), ["bulletList(one)", "bulletList(two)"]);
});

test("the first item has nothing to nest under", () => {
  const { ok, doc: out } = sinkAt(wrap(ol(null, li(para("one")), li(para("two")))), "one");
  assert.equal(ok, false);
  assert.equal(out, null);
});
