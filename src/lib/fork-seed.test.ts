import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { forkSeed } from "./fork-seed";
import { pmDocContentSchema } from "./tiptap-schema";

// forkSeed's strip is the only guard against a fork copying its parent's
// notes (docs/FORKS.md, "Mistakes that fail no check"): the doc schema has
// the `annotation` mark, so nothing downstream refuses a body that kept it.

const author = (authorId: string) => ({ type: "authorHighlight", attrs: { authorId } });
const note = (id: string) => ({ type: "annotation", attrs: { id } });
const text = (value: string, ...marks: object[]): JSONContent => ({ type: "text", text: value, ...(marks.length > 0 ? { marks } : {}) }) as JSONContent;
const cell = (...content: JSONContent[]): JSONContent => ({ type: "tableCell", content: [{ type: "paragraph", content }] });

const parentBody: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("A heading", author("u1"), note("a1"))] },
    {
      type: "paragraph",
      content: [
        text("Plain, "),
        text("noted by two", author("u1"), note("a1"), note("a2")),
        text(" and bold", { type: "bold" }, author("u2"), note("a2")),
        text(" and only noted", note("a3")),
      ],
    },
    {
      type: "bulletList",
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("In a list", author("u2"), note("a4"))] }] }],
    },
    { type: "table", content: [{ type: "tableRow", content: [cell(text("In a cell", note("a5"))), cell(text("Beside it", author("u1")))] }] },
  ],
};

function marksIn(doc: JSONContent): string[] {
  const names: string[] = [];
  const walk = (node: JSONContent) => {
    for (const mark of node.marks ?? []) names.push(mark.type);
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return names;
}

const source = (json: JSONContent, title = "", styles = {}) => ({ json, title, chips: { inputs: { styles } } });

test("the doc schema accepts an annotation mark, so the strip is the only guard", () => {
  assert.doesNotThrow(() => pmDocContentSchema.nodeFromJSON(parentBody).check());
  assert.equal(marksIn(parentBody).filter((name) => name === "annotation").length, 7);
});

test("no annotation mark reaches the seed, at any depth", () => {
  const { body } = forkSeed(source(parentBody));
  assert.equal(marksIn(body).includes("annotation"), false);
  assert.doesNotThrow(() => pmDocContentSchema.nodeFromJSON(body).check());
});

test("author marks and formatting stay, so inherited text still shows who wrote it", () => {
  const { body } = forkSeed(source(parentBody));
  assert.deepEqual(
    marksIn(body),
    marksIn(parentBody).filter((name) => name !== "annotation"),
  );
  const seeded = pmDocContentSchema.nodeFromJSON(body);
  assert.equal(seeded.textContent, pmDocContentSchema.nodeFromJSON(parentBody).textContent);
  // A run whose only mark was a note keeps no empty marks array, which ProseMirror never writes.
  assert.equal(JSON.stringify(body).includes('"marks":[]'), false);
});

test("the parent's body is not changed", () => {
  const before = JSON.stringify(parentBody);
  forkSeed(source(parentBody));
  assert.equal(JSON.stringify(parentBody), before);
});

test("the title and the chip styles come from the state as they are", () => {
  const styles = { mention: { form: "initials" } };
  const seed = forkSeed(source(parentBody, "My essay", styles));
  assert.equal(seed.title, "My essay");
  assert.deepEqual(seed.chipStyles, styles);
  assert.equal(forkSeed(source(parentBody)).title, "");
});
