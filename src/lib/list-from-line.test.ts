import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, Selection, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createChainableState, getTextContentFromNodes, wrappingInputRule, type InputRule } from "@tiptap/core";
import { pmSchema } from "./tiptap-schema";
import { atLine, splitAtLineEdges } from "./list-from-line";
import { typedOrderedListInputRule } from "./ordered-list-input-rule";

// docs/TIPTAP.md "A list starts at a line break".

const schema = pmSchema;
type Json = Record<string, unknown>;

/** "a|b|c" → one paragraph of three lines joined by hard breaks; "" lines are empty. */
const lines = (spec: string): Json => ({
  type: "paragraph",
  content: spec
    .split("|")
    .flatMap((text, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(text ? [{ type: "text", text }] : [])]),
});
const plain = (node: PMNode) => JSON.parse(JSON.stringify(node.toJSON()));
const docOf = (...content: Json[]) => schema.nodeFromJSON({ type: "doc", content });

/** Where `needle` starts (or, with `end`, ends) in `doc`'s text, as a document position. */
function at(doc: PMNode, needle: string, end = false): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(needle)) {
      found = pos + node.text!.indexOf(needle) + (end ? needle.length : 0);
    }
  });
  if (found < 0) throw new Error(`no ${needle}`);
  return found;
}

function split(doc: PMNode, from: number, to = from) {
  const tr = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }).tr;
  const changed = splitAtLineEdges(tr);
  const { from: f, to: t } = tr.selection;
  return { changed, content: plain(tr.doc).content as Json[], selected: tr.doc.textBetween(f, t, "|", "|"), tr };
}

test("a caret on a middle line splits it out with the lines either side kept", () => {
  const doc = docOf(lines("one|two|three"));
  const { changed, content, tr } = split(doc, at(doc, "tw") + 1);
  assert.equal(changed, true);
  assert.deepEqual(content, [lines("one"), lines("two"), lines("three")]);
  assert.equal(tr.selection.$from.parent.textContent, "two");
});

test("a caret on the last line leaves the lines above as one paragraph", () => {
  const doc = docOf(lines("one|two|three"));
  const { content } = split(doc, at(doc, "three", true));
  assert.deepEqual(content, [lines("one|two"), lines("three")]);
});

test("a caret on the first line splits only below it", () => {
  const doc = docOf(lines("one|two"));
  const { content } = split(doc, 1);
  assert.deepEqual(content, [lines("one"), lines("two")]);
});

test("a caret at a line's end stays on that line, not the next", () => {
  const doc = docOf(lines("one|two|three"));
  const { tr } = split(doc, at(doc, "two", true));
  assert.equal(tr.selection.$from.parent.textContent, "two");
  assert.equal(tr.selection.empty, true);
});

test("a caret at a line's start stays on that line, not the one above", () => {
  const doc = docOf(lines("one|two|three"));
  const { tr } = split(doc, at(doc, "two"));
  assert.equal(tr.selection.$from.parent.textContent, "two");
});

test("a selection across lines keeps them together, split at both ends", () => {
  const doc = docOf(lines("one|two|three|four"));
  const { content, selected } = split(doc, at(doc, "tw") + 1, at(doc, "thr") + 1);
  assert.deepEqual(content, [lines("one"), lines("two|three"), lines("four")]);
  assert.equal(selected, "wo|t");
});

test("a selection ending at a line's very start leaves that line out", () => {
  const doc = docOf(lines("one|two|three"));
  const { content } = split(doc, at(doc, "two"), at(doc, "three"));
  assert.deepEqual(content, [lines("one"), lines("two"), lines("three")]);
});

test("an empty line between two breaks becomes an empty paragraph of its own", () => {
  const doc = docOf(lines("one||three"));
  // The empty line's one position: just after the first break.
  const { content } = split(doc, at(doc, "one", true) + 1);
  assert.deepEqual(content, [lines("one"), { type: "paragraph" }, lines("three")]);
});

test("a paragraph without a break is left alone", () => {
  const doc = docOf(lines("one"));
  assert.equal(split(doc, 2).changed, false);
});

test("nothing splits inside a list: a break in an item is the item's own", () => {
  const doc = docOf({ type: "bulletList", content: [{ type: "listItem", content: [lines("one|two")] }] });
  const { changed, content } = split(doc, at(doc, "two"));
  assert.equal(changed, false);
  assert.deepEqual(content, plain(doc).content);
});

test("inside a blockquote the split happens within it", () => {
  const doc = docOf({ type: "blockquote", content: [lines("one|two")] });
  const { content } = split(doc, at(doc, "two", true));
  assert.deepEqual(content, [{ type: "blockquote", content: [lines("one"), lines("two")] }]);
});

// The input rules, run as TipTap's plugin runs one: the textblock's text
// (a hard break read as "\n") plus what was typed, matched, then the
// handler on a chainable state. Null when no rule fires and the keystroke
// types.
const bulletRule = wrappingInputRule({ find: /^\s*([-+*])\s$/, type: schema.nodes.bulletList });
const numberRule = wrappingInputRule({
  find: /^(\d+)\.\s$/,
  type: schema.nodes.orderedList,
  getAttributes: (match) => ({ start: +match[1] }),
});

/** `typed` at `pos`, the end of the doc's last textblock by default: the transaction, or null when no rule fires. */
function typeTr(rule: InputRule, doc: PMNode, typed: string, pos = Selection.atEnd(doc).from) {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  const text = getTextContentFromNodes(state.doc.resolve(pos)) + typed;
  const found = typeof rule.find === "function" ? rule.find(text) : rule.find.exec(text);
  if (!found) return null;
  const matched = "text" in found ? found.text : found[0];
  const match = Object.assign([matched] as [string], { index: found.index, input: text });
  const tr = state.tr;
  const result = rule.handler({
    state: createChainableState({ state, transaction: tr }),
    range: { from: pos - (matched.length - typed.length), to: pos },
    match,
    commands: undefined as never,
    chain: undefined as never,
    can: undefined as never,
  });
  return result === null || !tr.steps.length ? null : tr;
}

/** The doc's content after `typeTr`. */
function type(rule: InputRule, doc: PMNode, typed: string, pos?: number): Json[] | null {
  const tr = typeTr(rule, doc, typed, pos);
  return tr && (plain(tr.doc).content as Json[]);
}

const list = (type: string, attrs: Json | null, text: string): Json => ({
  type,
  ...(attrs ? { attrs } : {}),
  content: [{ type: "listItem", content: [text ? lines(text) : { type: "paragraph" }] }],
});
const withDefaults = (content: Json[] | null) => content && JSON.parse(JSON.stringify(docOf(...content).toJSON())).content;

const bullets = atLine(bulletRule);

test('"- " after a break makes a bullet list of that line only', () => {
  assert.deepEqual(type(bullets, docOf(lines("Lead-in:|-")), " "), withDefaults([lines("Lead-in:"), list("bulletList", null, "")]));
});

test('"3. " after a break starts a numbered list at 3', () => {
  const content = type(atLine(numberRule), docOf(lines("one|two|3.")), " ");
  assert.deepEqual(content, withDefaults([lines("one|two"), list("orderedList", { start: 3 }, "")]));
});

test('"b) " after a break makes a lettered list from b', () => {
  const content = type(atLine(typedOrderedListInputRule(schema.nodes.orderedList)), docOf(lines("one|b)")), " ");
  assert.deepEqual(content, withDefaults([lines("one"), list("orderedList", { start: 2, type: "a" }, "")]));
});

test("a marker on a middle line lists that line alone: the lines below stay text", () => {
  // a⏎b⏎1.⏎c with the caret after "1.", as typed on the empty line of a⏎b⏎⏎c.
  const doc = docOf(lines("a|b|1.|c"));
  const content = type(atLine(numberRule), doc, " ", at(doc, "1.", true));
  assert.deepEqual(content, withDefaults([lines("a|b"), list("orderedList", { start: 1 }, ""), lines("c")]));
});

test("the caret lands in the new item, not on the line below it", () => {
  // The break right after the caret becomes the boundary, which a caret
  // mapped forward would cross into "c".
  for (const spec of ["a|b|1.|c", "1.|c"]) {
    const doc = docOf(lines(spec));
    const tr = typeTr(atLine(numberRule), doc, " ", at(doc, "1.", true))!;
    assert.equal(tr.selection.$from.node(-1).type.name, "listItem", spec);
    assert.equal(tr.selection.empty, true, spec);
  }
});

test("the caret stays where it was in the item when the line has text after it", () => {
  const doc = docOf(lines("a|-rest|c"));
  const tr = typeTr(bullets, doc, " ", at(doc, "-", true))!;
  assert.equal(tr.selection.$from.node(-1).type.name, "listItem");
  assert.equal(tr.selection.$from.parentOffset, 0);
});

test("a marker on a paragraph's first line lists that line alone", () => {
  const doc = docOf(lines("-|c"));
  assert.deepEqual(type(bullets, doc, " ", at(doc, "-", true)), withDefaults([list("bulletList", null, ""), lines("c")]));
});

test("a marker on a one-line paragraph wraps it, as the package's rule does", () => {
  assert.deepEqual(type(bullets, docOf(lines("-")), " "), withDefaults([list("bulletList", null, "")]));
});

test("the rest of the marker's line goes into the item with it", () => {
  // Typed before existing text: "-" then " " with "rest" already after the caret.
  const doc = docOf(lines("a|-rest|c"));
  const content = type(bullets, doc, " ", at(doc, "-", true));
  assert.deepEqual(content, withDefaults([lines("a"), list("bulletList", null, "rest"), lines("c")]));
});

test("inside a list item the package's rule runs unchanged", () => {
  // An item's second paragraph, which the package's rule nests a list from.
  const doc = docOf({ type: "bulletList", content: [{ type: "listItem", content: [lines("x"), lines("-")] }] });
  const content = type(bullets, doc, " ");
  assert.notEqual(content, null);
  assert.deepEqual(content, type(bulletRule, doc, " "));
});

test("a marker after a break inside a list item stays text", () => {
  const doc = docOf({ type: "bulletList", content: [{ type: "listItem", content: [lines("one|-")] }] });
  assert.equal(type(bullets, doc, " "), null);
});

test("text before the marker on its line keeps it text", () => {
  assert.equal(type(bullets, docOf(lines("one|so -")), " "), null);
});
