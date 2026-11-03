import { test } from "node:test";
import assert from "node:assert/strict";
import type { Node as PMNode } from "@tiptap/pm/model";
import { pmDocContentSchema as schema } from "./tiptap-schema";
import { indentTarget } from "./indent-extension";

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
