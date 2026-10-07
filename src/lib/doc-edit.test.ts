import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import type { Node as PMNode } from "@tiptap/pm/model";
import { pmDocContentSchema } from "./tiptap-schema";
import { planEdits, type EditSpec } from "./doc-edit";
import { writeBackDoc } from "./doc-edit-yjs";
import { markdownToBlocks, markdownToText } from "./markdown-import";

// docs/MCP.md §6 — a targeted edit's rejection surface and its marks: what
// must be refused, which marks a surviving word keeps and a new one gets, and
// the block-by-block write-back's promise that a block the edit didn't touch
// keeps its Yjs items.

const schema = pmDocContentSchema;
const LUKE = "user-luke";
const CLAUDE = "user-claude";

type Run = { text: string; author?: string; note?: string | string[]; bold?: boolean };
const p = (...runs: (string | Run)[]) => ({
  type: "paragraph",
  content: runs.map((run) => {
    const r = typeof run === "string" ? { text: run } : run;
    const notes = r.note === undefined ? [] : Array.isArray(r.note) ? r.note : [r.note];
    return {
      type: "text",
      text: r.text,
      marks: [
        ...(r.bold ? [{ type: "bold" }] : []),
        ...(r.author ? [{ type: "authorHighlight", attrs: { authorId: r.author } }] : []),
        ...notes.map((id) => ({ type: "annotation", attrs: { id } })),
      ],
    };
  }),
});
const h = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const doc = (...content: object[]) => schema.nodeFromJSON({ type: "doc", content });
const md = (markdown: string) => markdownToBlocks(markdown);
const options = { schema, authorId: CLAUDE, asText: markdownToText };

/** Every text node's text with the author and annotations it carries, in order. */
function runs(node: PMNode): { text: string; author: string | null; notes: string[]; bold: boolean }[] {
  const out: { text: string; author: string | null; notes: string[]; bold: boolean }[] = [];
  node.descendants((child) => {
    if (!child.isText) return;
    out.push({
      text: child.text!,
      author: (child.marks.find((m) => m.type.name === "authorHighlight")?.attrs.authorId as string) ?? null,
      notes: child.marks.filter((m) => m.type.name === "annotation").map((m) => m.attrs.id as string),
      bold: child.marks.some((m) => m.type.name === "bold"),
    });
  });
  return out;
}

function plan(d: PMNode, edits: EditSpec[]) {
  const result = planEdits(d, edits, options);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result;
}

test("one word replaced keeps every other word's author, and the new word is the actor's", () => {
  const d = doc(p({ text: "The quick brown fox jumps.", author: LUKE }));
  const { next, changed } = plan(d, [{ kind: "replace", target: { quote: "quick" }, blocks: md("slow") }]);
  assert.deepEqual(runs(next), [
    { text: "The ", author: LUKE, notes: [], bold: false },
    { text: "slow", author: CLAUDE, notes: [], bold: false },
    { text: " brown fox jumps.", author: LUKE, notes: [], bold: false },
  ]);
  assert.deepEqual(changed, [1]);
});

test("a note stays on a passage the edit rewords, word by word or whole, and not on a sentence added at its end", () => {
  const d = doc(p("Before. ", { text: "The claim is strong", note: "a1", author: LUKE }, " after."));

  const oneWord = plan(d, [{ kind: "replace", target: { quote: "strong" }, blocks: md("weak") }]).next;
  assert.deepEqual(
    runs(oneWord).filter((r) => r.notes.includes("a1")).map((r) => r.text).join(""),
    "The claim is weak",
  );

  const whole = plan(d, [{ kind: "replace", target: { quote: "The claim is strong" }, blocks: md("A different assertion entirely") }]).next;
  assert.equal(runs(whole).filter((r) => r.notes.includes("a1")).map((r) => r.text).join(""), "A different assertion entirely");

  // A pure insertion right after the passage: the note's mark is on the word
  // before and not the one after, so the new words are outside it.
  const appended = plan(d, [
    { kind: "replace", target: { quote: "is strong after." }, blocks: md("is strong, and a new sentence follows. after.") },
  ]).next;
  assert.equal(runs(appended).filter((r) => r.notes.includes("a1")).map((r) => r.text).join(""), "The claim is strong");
});

test("overlapping notes both survive on the words they shared", () => {
  const d = doc(p({ text: "alpha ", note: "a1" }, { text: "beta", note: ["a1", "a2"] }, { text: " gamma", note: "a2" }));
  const { next } = plan(d, [{ kind: "replace", target: { quote: "beta" }, blocks: md("BETA") }]);
  assert.deepEqual(runs(next).find((r) => r.text === "BETA")?.notes.sort(), ["a1", "a2"]);
});

test("a word whose text is the same gains or loses just the formatting the new text gives it", () => {
  const d = doc(p({ text: "the key claim", author: LUKE }));
  const { next } = plan(d, [{ kind: "replace", target: { quote: "the key claim" }, blocks: md("the **key** claim") }]);
  assert.deepEqual(runs(next), [
    { text: "the ", author: LUKE, notes: [], bold: false },
    { text: "key", author: LUKE, notes: [], bold: true },
    { text: " claim", author: LUKE, notes: [], bold: false },
  ]);
});

test("blocks: an insertion between two rewritten paragraphs pairs each with its rewrite", () => {
  const d = doc(
    p({ text: "The first paragraph says one thing.", author: LUKE }),
    p({ text: "The second paragraph says another.", author: LUKE }),
  );
  const { next, changed } = plan(d, [
    {
      kind: "replace",
      target: { start: "The first", end: "says another." },
      blocks: md("The first paragraph says one thing, reworded.\n\nA new paragraph in between.\n\nThe second paragraph says another, reworded."),
    },
  ]);
  const texts = runs(next);
  // Surviving words keep Luke; the new words and the new paragraph are Claude's.
  assert.equal(texts.find((r) => r.text.startsWith("The first"))?.author, LUKE);
  assert.equal(texts.find((r) => r.text.startsWith("A new paragraph"))?.author, CLAUDE);
  assert.equal(texts.find((r) => r.text.startsWith("The second"))?.author, LUKE);
  assert.deepEqual(changed, [1, 2, 3]);
});

test("a paragraph replaced whole by a heading becomes one, and keeps its surviving words' marks", () => {
  const d = doc(p({ text: "Results", author: LUKE }), p("body"));
  const { next } = plan(d, [{ kind: "replace", target: { quote: "Results" }, blocks: md("## Results") }]);
  assert.equal(next.firstChild!.type.name, "heading");
  assert.equal(runs(next)[0].author, LUKE);
  // One paragraph of new text keeps the block's kind: a heading stays one.
  const heading = doc(h(2, "Old title"), p("x"));
  const { next: kept } = plan(heading, [{ kind: "replace", target: { quote: "Old title" }, blocks: md("New title") }]);
  assert.equal(kept.firstChild!.type.name, "heading");
});

test("refusals: no match with near misses, ambiguity with where, a heading crossed, a changed middle, overlap", () => {
  const d = doc(h(2, "One"), p("Repeated words here. More text follows."), h(2, "Two"), p("Repeated words here. End."));
  const none = planEdits(d, [{ kind: "replace", target: { quote: "More txt follows" }, blocks: md("x") }], options);
  assert.equal(!none.ok && none.refusal.code, "no_match");
  assert.ok(!none.ok && (none.refusal.details!.nearMisses as unknown[]).length > 0);

  const twice = planEdits(d, [{ kind: "replace", target: { quote: "Repeated words here." }, blocks: md("x") }], options);
  assert.equal(!twice.ok && twice.refusal.code, "ambiguous");
  assert.equal(!twice.ok && twice.refusal.details!.total, 2);
  const narrowed = planEdits(d, [{ kind: "replace", target: { quote: "Repeated words here.", suffix: "End." }, blocks: md("x") }], options);
  assert.equal(narrowed.ok, true);

  const crossing = planEdits(d, [{ kind: "replace", target: { start: "More text", end: "End." }, blocks: md("x") }], options);
  assert.equal(!crossing.ok && crossing.refusal.code, "invalid");
  const allowed = planEdits(d, [{ kind: "replace", target: { start: "More text", end: "End.", acrossHeadings: true }, blocks: md("x") }], options);
  assert.equal(allowed.ok, true);

  const changedMiddle = planEdits(
    d,
    [{ kind: "replace", target: { start: "More text", end: "follows.", expectText: "More text that follows." }, blocks: md("x") }],
    options,
  );
  assert.equal(!changedMiddle.ok && changedMiddle.refusal.code, "conflict");

  const overlap = planEdits(
    d,
    [
      { kind: "replace", target: { quote: "More text" }, blocks: md("a") },
      { kind: "replace", target: { quote: "text follows" }, blocks: md("b") },
    ],
    options,
  );
  assert.equal(!overlap.ok && overlap.refusal.code, "invalid");
});

test("append, and insert after a heading or at the end of its section", () => {
  const d = doc(h(2, "One"), p("first"), h(2, "Two"), p("second"));
  const appended = plan(d, [{ kind: "append", blocks: md("last") }]).next;
  assert.equal(appended.lastChild!.textContent, "last");
  const atStart = plan(d, [{ kind: "insert", heading: "One", blocks: md("under one") }]).next;
  assert.equal(atStart.child(1).textContent, "under one");
  const atEnd = plan(d, [{ kind: "insert", heading: "One", atEnd: true, blocks: md("end of one") }]).next;
  assert.equal(atEnd.child(2).textContent, "end of one");
  assert.equal(runs(atEnd).find((r) => r.text === "end of one")?.author, CLAUDE);
});

/** A Y.Doc holding `d` in its "default" fragment. */
function ydocOf(d: PMNode): Y.Doc {
  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(d, ydoc.getXmlFragment("default"));
  return ydoc;
}

test("the write-back changes only the blocks the edit changed, and the result decodes to the plan", () => {
  const d = doc(
    p({ text: "Untouched first paragraph.", author: LUKE }),
    p({ text: "Overlapping ", note: "a1" }, { text: "notes", note: ["a1", "a2"] }, { text: " here.", note: "a2" }),
    p({ text: "A paragraph to edit.", author: LUKE }),
  );
  const ydoc = ydocOf(d);
  const fragment = ydoc.getXmlFragment("default");
  const [first, second, third] = fragment.toArray();

  // An insertion ahead of the block with overlapping annotations, and an edit after it.
  const { next } = plan(d, [
    { kind: "replace", target: { quote: "Untouched first paragraph." }, blocks: md("Untouched first paragraph.\n\nA new paragraph after it.") },
    { kind: "replace", target: { quote: "to edit" }, blocks: md("now edited") },
  ]);
  ydoc.transact(() => writeBackDoc(fragment, d, next));

  assert.deepEqual(schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment)).toJSON(), next.toJSON());
  const after = fragment.toArray();
  assert.equal(after.length, 4);
  // The same Yjs elements, in place: the first and the annotated one untouched,
  // the edited one rewritten inside itself rather than replaced.
  assert.equal(after[0], first);
  assert.equal(after[2], second);
  assert.equal(after[3], third);
  ydoc.destroy();
});
