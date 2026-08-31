import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { pmSchema } from "./tiptap-schema";
import { applyTighten } from "./tighten-lines";

// EditorToolbar's "reduce space between lines" rules, pinned as a table —
// especially the interplay decisions that aren't derivable from the two
// rules alone: one press never cascades (an empty paragraph's removal makes
// its neighbours adjacent for the NEXT press, not this one), whitespace-only
// counts as empty, and anything that isn't a paragraph is a barrier.

type Json = Record<string, unknown>;

const p = (text?: string): Json => ({
  type: "paragraph",
  ...(text ? { content: [{ type: "text", text }] } : {}),
});

// <p>a<br/>b<br/>…</p> — what a merged run should look like.
const joined = (...texts: string[]): Json => ({
  type: "paragraph",
  content: texts.flatMap((text, i) =>
    i === 0 ? [{ type: "text", text }] : [{ type: "hardBreak" }, { type: "text", text }],
  ),
});

// Runs one press over [from, to] (defaulting to the whole document) and
// hands back the resulting layout.
function press(content: Json[], from?: number, to?: number) {
  const doc = pmSchema.nodeFromJSON({ type: "doc", content });
  const tr = EditorState.create({ doc }).tr;
  const changed = applyTighten(tr, from ?? 1, to ?? doc.content.size - 1);
  // Round-tripped through JSON: ProseMirror builds attrs objects with a null
  // prototype (tiptap-schema.ts's toPlainJSON comment), which deepStrictEqual
  // rightly refuses to equate with a plain literal.
  const result = JSON.parse(JSON.stringify((tr.doc.toJSON() as { content: Json[] }).content)) as Json[];
  return { changed, content: result, selection: tr.selection };
}

test("two adjacent paragraphs merge into one joined by a hard break", () => {
  const { changed, content } = press([p("A"), p("B")]);
  assert.equal(changed, true);
  assert.deepEqual(content, [joined("A", "B")]);
});

test("three or more collapse to a single paragraph in one press", () => {
  assert.deepEqual(press([p("A"), p("B"), p("C")]).content, [joined("A", "B", "C")]);
});

test("a lone empty paragraph disappears, and its neighbours do not merge this press", () => {
  assert.deepEqual(press([p("A"), p(), p("B")]).content, [p("A"), p("B")]);
});

test("a run of N empty paragraphs becomes N-1", () => {
  assert.deepEqual(press([p("A"), p(), p(), p(), p("B")]).content, [p("A"), p(), p(), p("B")]);
});

test("whitespace-only counts as empty, never merged in as invisible junk", () => {
  assert.deepEqual(press([p("A"), p("   "), p("B")]).content, [p("A"), p("B")]);
});

test("both rules apply in one press, each against the original layout", () => {
  assert.deepEqual(press([p("A"), p("B"), p(), p(), p("C")]).content, [joined("A", "B"), p(), p("C")]);
});

test("a heading is a barrier: nothing merges across it", () => {
  const h = { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H" }] };
  const { changed, content } = press([p("A"), h, p("B")]);
  assert.equal(changed, false);
  assert.deepEqual(content, [p("A"), h, p("B")]);
});

test("paragraphs merge within a selected blockquote, never across its edge", () => {
  const { content } = press([{ type: "blockquote", content: [p("A"), p("B")] }, p("C")]);
  assert.deepEqual(content, [{ type: "blockquote", content: [joined("A", "B")] }, p("C")]);
});

test("an empty paragraph that is its parent's only child survives", () => {
  // Deleting it would leave the blockquote ("block+") with no content.
  const quote = { type: "blockquote", content: [p()] };
  const { changed, content } = press([quote, p("A")]);
  assert.equal(changed, false);
  assert.deepEqual(content, [quote, p("A")]);
});

test("a paragraph half-covered by the selection participates fully", () => {
  // "AAAA" spans 1..5, "BBBB" 7..11 — select from inside one to inside the other.
  assert.deepEqual(press([p("AAAA"), p("BBBB")], 3, 9).content, [joined("AAAA", "BBBB")]);
});

test("inline marks survive the merge untouched", () => {
  const bold = { type: "paragraph", content: [{ type: "text", text: "A", marks: [{ type: "bold" }] }] };
  const { content } = press([bold, p("B")]);
  assert.deepEqual(content, [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "A", marks: [{ type: "bold" }] },
        { type: "hardBreak" },
        { type: "text", text: "B" },
      ],
    },
  ]);
});

test("the merged region stays selected, ready for another press", () => {
  const { selection } = press([p("A"), p("B")]);
  // Result is <p>A<br/>B</p>: text spans positions 1..4.
  assert.equal(selection.from, 1);
  assert.equal(selection.to, 4);
});

test("a collapsed selection is a no-op", () => {
  assert.equal(press([p("A"), p("B")], 2, 2).changed, false);
});

test("a selection inside a single paragraph changes nothing", () => {
  assert.equal(press([p("A"), p("B")], 1, 2).changed, false);
});
