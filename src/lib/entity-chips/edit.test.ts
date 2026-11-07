import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON, prosemirrorToYXmlFragment } from "y-prosemirror";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { planEdits, type EditSpec } from "../doc-edit";
import { writeBackDoc } from "../doc-edit-yjs";
import { docContentToMarkdown, markdownToBlocks, markdownToText } from "../markdown-import";
import { pmDocContentSchema } from "../tiptap-schema";
import { MENTION, type MentionUser } from "./kinds/mention";
import { chipIdentitiesBetween, chipMarkdowns, chipsIn } from "./renderings";
import { chipLabelsIn } from "./text";
import { DEFAULT_CHIP_STYLES, type ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, MCP items 2, 5 and 6 — an edit sent as Markdown, where
// the doc holds entity chips: what the parse takes for a chip, what the merge
// keeps, and what is refused or reported rather than lost.

const user = (id: string, name: string, slug: string): MentionUser => ({ id, name, initials: "", slug, deleted: false, botOf: null });
const INPUTS: ChipInputs = {
  styles: DEFAULT_CHIP_STYLES,
  context: { [MENTION]: { u1: user("u1", "Ada Lovelace", "ada"), u2: user("u2", "Grace Hopper", "grace") } },
};
const AUTHOR = "user-claude";

const chip = (iid: string, userId: string): JSONContent => ({ type: "entityChip", attrs: { kind: MENTION, iid, data: { userId } } });
const text = (value: string, author?: string): JSONContent => ({
  type: "text",
  text: value,
  ...(author ? { marks: [{ type: "authorHighlight", attrs: { authorId: author } }] } : {}),
});
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const docOf = (...blocks: JSONContent[]) => pmDocContentSchema.nodeFromJSON({ type: "doc", content: blocks });

const DOC = docOf(para(text("Ask ", "luke"), chip("i1", "u1"), text(" about the engine today.", "luke")), para(text("A second paragraph.")));
const LABELS = chipLabelsIn(DOC, INPUTS);
const options = { schema: pmDocContentSchema, authorId: AUTHOR, asText: markdownToText, labels: LABELS };

/** Markdown as an edit's blocks, each mention's handle resolved as the server would, to the user of that slug. */
function md(markdown: string, iid = "fresh"): JSONContent[] {
  const slugs: Record<string, string> = { ada: "u1", grace: "u2" };
  let n = 0;
  const resolve = (node: JSONContent): JSONContent => {
    if (node.type === "entityChip") {
      const slug = (node.attrs?.data as { slug: string }).slug;
      return { ...node, attrs: { kind: MENTION, iid: `${iid}${n++ || ""}`, data: { userId: slugs[slug] } } };
    }
    return node.content ? { ...node, content: node.content.map(resolve) } : node;
  };
  return markdownToBlocks(markdown, { chips: true }).map(resolve);
}

const replace = (quote: string, blocks: JSONContent[]): EditSpec => ({ kind: "replace", target: { quote }, blocks });
const chips = (node: PMNode) => chipsIn(node).map((c) => `${c.iid}:${(c.data as { userId: string }).userId}`);
const shown = (node: PMNode) => node.child(0).textBetween(0, node.child(0).content.size, "", (leaf) => `<${leaf.attrs.iid}>`);

// --- the parse -------------------------------------------------------------

test("parse: a mention's syntax is a placeholder holding its handle, only when chips are asked for", () => {
  const [block] = markdownToBlocks("Ask [@Ada Lovelace](/authors/ada) now.", { chips: true });
  assert.deepEqual(block.content, [
    { type: "text", text: "Ask " },
    // The words it showed ride along for an import that falls back to a link; resolving drops them.
    { type: "entityChip", attrs: { kind: MENTION, iid: "", data: { slug: "ada", label: "@Ada Lovelace" } } },
    { type: "text", text: " now." },
  ]);
  // The same Markdown on any other path is the link it says it is.
  const [plain] = markdownToBlocks("Ask [@Ada Lovelace](/authors/ada) now.");
  assert.equal(plain.content?.[1].marks?.[0].attrs?.href, "/authors/ada");
});

test("parse: the label is never read, and only the syntax counts", () => {
  const parsed = (markdown: string) => markdownToBlocks(markdown, { chips: true })[0].content ?? [];
  const isChipAt = (markdown: string) => parsed(markdown).some((node) => node.type === "entityChip");
  // Whatever the label says, in whatever style.
  assert.ok(isChipAt("[@AL](/authors/ada)"));
  assert.ok(isChipAt("[@anything at all](/authors/ada)"));
  assert.ok(isChipAt("~~[@Gone Person](/authors/gone)~~"));
  // An escaped @, as a hand-written link is written out: a link.
  assert.ok(!isChipAt("[\\@Andrew](/authors/andrew)"));
  // No @, another destination, or formatting before the @: links.
  assert.ok(!isChipAt("[his page](/authors/ada)"));
  assert.ok(!isChipAt("[@home](/elsewhere)"));
  assert.ok(!isChipAt("[**@Ada**](/authors/ada)"));
  assert.ok(!isChipAt("[@Ada](/authors/ada/extra)"));
  assert.ok(!isChipAt("[@Ada](https://example.com/authors/ada)"));
  // And a bare @name is text.
  assert.ok(!isChipAt("ask @ada about it"));
});

test("round trip: what a read writes for a chip parses back to that chip's handle, and a hand-written link to a link", () => {
  const doc = docOf(
    para(text("Ask "), chip("i1", "u1"), text(" or "), { type: "text", text: "@Andrew", marks: [{ type: "link", attrs: { href: "/authors/andrew" } }] }),
  );
  const written = docContentToMarkdown(doc.toJSON(), chipMarkdowns(chipsIn(doc), INPUTS.styles, INPUTS.context));
  const [block] = markdownToBlocks(written, { chips: true });
  assert.deepEqual(
    block.content?.map((node) => (node.type === "entityChip" ? `chip:${(node.attrs?.data as { slug: string }).slug}` : `${node.text}|${node.marks?.[0]?.attrs?.href ?? ""}`)),
    ["Ask |", "chip:ada", " or |", "@Andrew|/authors/andrew"],
  );
});

// --- the merge -------------------------------------------------------------

function plan(edits: EditSpec[], doc = DOC) {
  const result = planEdits(doc, edits, options);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result;
}

test("merge: an edit beside a chip leaves the chip as it was", () => {
  const { next, chips: changes } = plan([replace("about the engine", md("about the loom"))]);
  assert.deepEqual(chips(next), ["i1:u1"]);
  assert.equal(shown(next), "Ask <i1> about the loom today.");
  assert.deepEqual(changes, { removed: [], added: 0 });
  assert.ok(next.child(0).child(1).eq(DOC.child(0).child(1)));
});

test("merge: a passage rewritten around its mention keeps that mention, instance id and all", () => {
  // The quote is what a text read showed; the new text writes the mention as a Markdown read shows it.
  const { next, chips: changes } = plan([
    replace("Ask @Ada Lovelace about the engine", md("Please ask [@Ada Lovelace](/authors/ada) about the loom")),
  ]);
  assert.equal(shown(next), "Please ask <i1> about the loom today.");
  assert.deepEqual(chips(next), ["i1:u1"]);
  assert.deepEqual(changes, { removed: [], added: 0 });
  // Whatever label the agent typed: the chip is matched by who it is.
  const relabelled = plan([replace("Ask @Ada Lovelace about", md("Ask [@A. Lovelace, Countess](/authors/ada) about"))]);
  assert.deepEqual(chips(relabelled.next), ["i1:u1"]);
});

test("merge: a mention left out is removed, and the answer says so", () => {
  const { next, chips: changes } = plan([replace("Ask @Ada Lovelace about the engine", md("Ask about the loom"))]);
  assert.deepEqual(chips(next), []);
  assert.deepEqual(changes, { removed: ["@Ada Lovelace"], added: 0 });
});

test("merge: a mention of someone else is one removed and one added, the new one with an id of its own", () => {
  const { next, chips: changes } = plan([replace("Ask @Ada Lovelace about", md("Ask [@Grace Hopper](/authors/grace) about", "new"))]);
  assert.deepEqual(chips(next), ["new:u2"]);
  assert.deepEqual(changes, { removed: ["@Ada Lovelace"], added: 1 });
});

test("merge: a second mention of the same person is added beside the first, which keeps its place", () => {
  const { next, chips: changes } = plan([
    replace("about the engine", md("and again [@Ada Lovelace](/authors/ada) about the engine", "new")),
  ]);
  assert.deepEqual(chips(next), ["i1:u1", "new:u1"]);
  assert.deepEqual(changes, { removed: [], added: 1 });
});

test("merge: new words beside a kept mention are the actor's, and the old ones keep their author", () => {
  const { next } = plan([replace("Ask @Ada Lovelace about", md("Please ask [@Ada Lovelace](/authors/ada) about"))]);
  const authors: string[] = [];
  next.child(0).forEach((child) => {
    if (child.isText) authors.push(`${child.text}|${child.marks.find((m) => m.type.name === "authorHighlight")?.attrs.authorId ?? ""}`);
  });
  // Which of the two spaces around "ask" is the old one is the diff's to say.
  assert.deepEqual(authors, ["Please|user-claude", " |luke", "ask |user-claude", " about the engine today.|luke"]);
});

// --- the refusals ----------------------------------------------------------

test("refused: a mention sent back as its name in plain words", () => {
  for (const typed of ["Ask @Ada Lovelace about the loom", "Ask Ada Lovelace about the loom", "Ask ada  lovelace about the loom"]) {
    const result = planEdits(DOC, [replace("Ask @Ada Lovelace about the engine", md(typed))], options);
    assert.equal(result.ok, false, typed);
    assert.ok(!result.ok && result.refusal.code === "chip_as_text" && result.refusal.edit === -1, typed);
    assert.deepEqual(!result.ok && result.refusal.details, { labels: ["@Ada Lovelace"] }, typed);
  }
});

test("not refused: the same name typed somewhere the mention wasn't", () => {
  const { next } = plan([replace("A second paragraph.", md("A second paragraph, about Ada Lovelace."))]);
  assert.deepEqual(chips(next), ["i1:u1"]);
});

test("not refused: a revert that puts plain words back where a mention was", () => {
  const result = planEdits(DOC, [{ kind: "replaceBlock", text: "Ask @Ada Lovelace about the engine today.", block: para(text("Ask Ada Lovelace about the engine today.")) }], {
    ...options,
    keepMarks: true,
  });
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.chips, { removed: ["@Ada Lovelace"], added: 0 });
});

test("refused: a passage that begins or ends partway through a mention", () => {
  for (const quote of ["Ask @Ada", "Lovelace about the engine", "Ada"]) {
    const result = planEdits(DOC, [replace(quote, md("Tell"))], options);
    assert.ok(!result.ok && result.refusal.code === "splits_chip", quote);
    // It says what the whole of it would be.
    assert.ok(!result.ok && String(result.refusal.details?.passage).includes("@Ada Lovelace"), quote);
  }
  // Named by its ends, the same, when it is the passage's own edge that falls inside one.
  const named: EditSpec = { kind: "replace", target: { start: "Lovelace about", end: "engine" }, blocks: md("about the loom") };
  const result = planEdits(DOC, [named], options);
  assert.ok(!result.ok && result.refusal.code === "splits_chip");
});

test("refused: replacing a passage that holds a chip of a kind this server doesn't know", () => {
  const doc = docOf(para(text("See "), { type: "entityChip", attrs: { kind: "hologram", iid: "h1", data: { of: "x" } } }, text(" for details. And more.")));
  const labels = chipLabelsIn(doc, INPUTS);
  const over = planEdits(doc, [replace("See […] for details", md("See the appendix"))], { ...options, labels });
  assert.ok(!over.ok && over.refusal.code === "unknown_kind");
  assert.deepEqual(!over.ok && over.refusal.details?.kinds, ["hologram"]);
  // The words beside it can be edited, and it stays where it was.
  const beside = planEdits(doc, [replace("And more.", md("And much more."))], { ...options, labels });
  assert.ok(beside.ok);
  assert.deepEqual(beside.ok && chipsIn(beside.next).map((c) => c.kind), ["hologram"]);
});

test("refused: a passage whose mention became someone else's since it was read", () => {
  const then = DOC;
  const now = docOf(para(text("Ask "), chip("i9", "u2"), text(" about the engine today.")), para(text("A second paragraph.")));
  const named: EditSpec = {
    kind: "replace",
    target: { start: "Ask", end: "engine", expectText: then.textBetween(1, 23, " "), expectChips: chipIdentitiesBetween(then, 1, 23) },
    blocks: md("Ask about the loom"),
  };
  // Every chip is the same character in the text compared, so the text alone agrees.
  assert.equal(now.textBetween(1, 23, " "), then.textBetween(1, 23, " "));
  const result = planEdits(now, [named], { ...options, labels: chipLabelsIn(now, INPUTS) });
  assert.ok(!result.ok && result.refusal.code === "conflict");
  assert.deepEqual(!result.ok && result.refusal.details, { textNow: "Ask @Grace Hopper about the engine" });
  // Unchanged, it goes through.
  assert.ok(planEdits(then, [named], options).ok);
});

// --- the write-back --------------------------------------------------------

test("write-back: a kept chip survives the ydoc round trip with its instance id, and an added one arrives whole", () => {
  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(DOC, ydoc.getXmlFragment("default"));
  const { next } = plan([
    replace("Ask @Ada Lovelace about the engine", md("Ask [@Ada Lovelace](/authors/ada) and [@Grace Hopper](/authors/grace) about the loom", "new")),
  ]);
  writeBackDoc(ydoc.getXmlFragment("default"), DOC, next);
  const back = pmDocContentSchema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment("default")));
  // The first parsed mention is the old chip again; the second is the added one.
  assert.deepEqual(chips(back), ["i1:u1", "new1:u2"]);
  assert.equal(shown(back), "Ask <i1> and <new1> about the loom today.");
});
