import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createChainableState } from "@tiptap/core";
import { pmDocContentSchema } from "./tiptap-schema";
import { TYPED_ORDERED_LIST_INPUT, typedOrderedListInput, typedOrderedListInputRule } from "./ordered-list-input-rule";

// docs/TIPTAP.md "Typing a marker starts a lettered or Roman list".

const schema = pmDocContentSchema;
const para = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
const item = (text: string) => schema.nodes.listItem.create(null, para(text));
const ol = (type: string | null, start: number, ...texts: string[]) =>
  schema.nodes.orderedList.create({ start, type }, texts.map(item));

/**
 * The doc after typing `typed` at the end of a last paragraph holding `text`,
 * with `above` before it, as TipTap's input-rule plugin runs a rule: the
 * textblock's text plus what was typed, matched, then the handler on a
 * chainable state. Null when the rule declines and the keystroke types.
 */
function type(above: PMNode[], text: string, typed: string): PMNode | null {
  const doc = schema.nodes.doc.create(null, [...above, para(text)]);
  const at = doc.content.size - 1;
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, at) });
  const match = TYPED_ORDERED_LIST_INPUT.exec(text + typed);
  if (!match) return null;
  const tr = state.tr;
  const result = typedOrderedListInputRule(schema.nodes.orderedList).handler({
    state: createChainableState({ state, transaction: tr }),
    range: { from: at - (match[0].length - typed.length), to: at },
    match,
    commands: undefined as never,
    chain: undefined as never,
    can: undefined as never,
  });
  return result === null || !tr.steps.length ? null : tr.doc;
}

/** Each top-level list as its type, start and item count; a paragraph as "p". */
function shape(doc: PMNode | null) {
  if (!doc) return null;
  const out: (string | [string | null, number, number])[] = [];
  doc.forEach((node) =>
    out.push(node.type.name === "orderedList" ? [node.attrs.type, node.attrs.start, node.childCount] : "p"),
  );
  return out;
}

test("a first marker then ) and a space, or . and two spaces, starts a list of its style", () => {
  assert.deepEqual(shape(type([], "a)", " ")), [["a", 1, 1]]);
  assert.deepEqual(shape(type([], "A. ", " ")), [["A", 1, 1]]);
  assert.deepEqual(shape(type([], "i)", " ")), [["i", 1, 1]]);
  assert.deepEqual(shape(type([], "I. ", " ")), [["I", 1, 1]]);
  // The browser can put a no-break space in for the second of two.
  assert.deepEqual(shape(type([], "a. ", "\u00a0")), [["a", 1, 1]]);
});

test("one space after a period stays text: initials and abbreviations open nothing", () => {
  for (const text of ["C.", "I.", "A.", "a.", "N."]) assert.equal(type([], text, " "), null, text);
  assert.equal(TYPED_ORDERED_LIST_INPUT.test("C. S. "), false);
  assert.equal(TYPED_ORDERED_LIST_INPUT.test("St.  "), true); // shape only; the decision refuses it
  assert.equal(type([], "St.", " "), null);
  assert.equal(type([], "St. ", " "), null);
  assert.equal(type([], "cf)", " "), null);
});

test("a marker with no list before it is read on its own, as the Markdown parse reads a first marker", () => {
  assert.deepEqual(shape(type([], "c)", " ")), [["a", 3, 1]]);
  assert.deepEqual(shape(type([], "B. ", " ")), [["A", 2, 1]]);
  assert.deepEqual(shape(type([], "ii)", " ")), [["i", 2, 1]]);
  assert.deepEqual(shape(type([], "v)", " ")), [["a", 22, 1]]);
  assert.deepEqual(shape(type([], "IV)", " ")), [["I", 4, 1]]);
});

test("a later marker continues the list directly above when it is that list's next marker", () => {
  assert.deepEqual(shape(type([ol("a", 1, "x", "y")], "c)", " ")), [["a", 1, 3]]);
  assert.deepEqual(shape(type([ol("i", 1, "x", "y", "z")], "iv. ", " ")), [["i", 1, 4]]);
  assert.deepEqual(shape(type([ol("A", 3, "x")], "D)", " ")), [["A", 3, 2]]);
  // "i" after h is the ninth letter, not Roman 1.
  assert.deepEqual(shape(type([ol("a", 1, "1", "2", "3", "4", "5", "6", "7", "8")], "i)", " ")), [["a", 1, 9]]);
});

test("across discussion, a marker carries on from the nearest earlier list it continues", () => {
  // a) one, b) two, some discussion, c) three.
  assert.deepEqual(shape(type([ol("a", 1, "one", "two"), para("some discussion")], "c)", " ")), [
    ["a", 1, 2],
    "p",
    ["a", 3, 1],
  ]);
  // Roman 5 after i–iv, where "v" alone would be the letter.
  assert.deepEqual(shape(type([ol("i", 1, "1", "2", "3", "4"), para("between")], "v)", " ")), [
    ["i", 1, 4],
    "p",
    ["i", 5, 1],
  ]);
  // Past a nearer list it doesn't continue.
  assert.deepEqual(
    shape(type([ol("i", 1, "1", "2", "3", "4"), para("p"), ol("a", 1, "x"), para("q")], "v)", " ")),
    [["i", 1, 4], "p", ["a", 1, 1], "p", ["i", 5, 1]],
  );
});

test("a marker that continues nothing before it starts a list of its own", () => {
  assert.deepEqual(shape(type([ol("a", 1, "x", "y")], "a)", " ")), [["a", 1, 2], ["a", 1, 1]]);
  assert.deepEqual(shape(type([ol("a", 1, "x", "y")], "e)", " ")), [["a", 1, 2], ["a", 5, 1]]);
  assert.deepEqual(shape(type([ol("a", 1, "x")], "i)", " ")), [["a", 1, 1], ["i", 1, 1]]);
  // A numbered list is continued by numbers, not letters.
  assert.deepEqual(shape(type([ol(null, 1, "x")], "b)", " ")), [[null, 1, 1], ["a", 2, 1]]);
});

test("the decision, on its own", () => {
  assert.deepEqual(typedOrderedListInput("a", []), { type: "a", start: 1, join: false });
  assert.deepEqual(typedOrderedListInput("I", []), { type: "I", start: 1, join: false });
  assert.deepEqual(typedOrderedListInput("b", [ol("a", 1, "x")]), { type: "a", start: 2, join: true });
  assert.deepEqual(typedOrderedListInput("b", [ol("a", 1, "x"), para("p")]), { type: "a", start: 2, join: false });
  assert.deepEqual(typedOrderedListInput("ii", [ol("i", 1, "x")]), { type: "i", start: 2, join: true });
  assert.equal(typedOrderedListInput("cf", []), null);
});
