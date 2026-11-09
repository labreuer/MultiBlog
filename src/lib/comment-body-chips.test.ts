import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import {
  commentBodyText,
  commentChipInputs,
  COMMENT_CHIP_STYLES,
  conformCommentChips,
  freshCommentChipTargets,
  isCommentBodyError,
  MAX_CHIPS_PER_COMMENT,
  parseCommentBody,
} from "./comment-body";
import { applyQuoteResolutions, extractQuoteCandidates, quotedContentIn } from "./comment-quote-extract";
import { flattenForMatch, matchQuoteAcross, quotedTextAt } from "./comment-quote-match";
import { CITATION, type CitationContext, type CitedWork } from "./entity-chips/kinds/citation";
import { MENTION, type MentionUser } from "./entity-chips/kinds/mention";
import { chipsForFinding } from "./entity-chips/placeholders";
import { chipMarkdowns, chipsIn, chipsInJSON } from "./entity-chips/renderings";
import { chipLabelsIn } from "./entity-chips/text";
import { CHIP_ANCHOR_TEXT, ENTITY_CHIP } from "./entity-chips/types";
import { commentContentToMarkdown, markdownToCommentContent } from "./markdown-import";
import { pmCommentContentSchema, pmSchema } from "./tiptap-schema";

// docs/ENTITY_CHIPS.md, "Planned: chips in comments" — the browser-safe half:
// the comment parse and writer, what a stored chip may be, the labelled
// text, and a quotation that copies a passage's chips. Who may be named, and
// a key the library doesn't have, are the server's (comment-chips.ts), and
// e2e/comment-chips.spec.ts covers them.

const user = (id: string, name: string, slug: string): MentionUser => ({ id, name, initials: "", slug, deleted: false, botOf: null });
const work = (id: string, more: Partial<CitedWork> = {}): CitedWork => {
  const fields = { id, key: id, short: "OI", names: "Radner", year: 2012, title: "The Origin of Ideas", deleted: false, ...more };
  const entry = { authors: fields.names, year: String(fields.year), title: fields.title, titleIsContainer: true, source: "" };
  return { entry, ...fields };
};
const CONTEXT = {
  [MENTION]: { u1: user("u1", "Ada Lovelace", "ada"), u2: user("u2", "Grace Hopper", "grace") },
  [CITATION]: { radner2012: work("radner2012"), barfield1957: work("barfield1957", { names: "Barfield", year: 1957, short: "SA" }) } satisfies CitationContext,
};
const INPUTS = commentChipInputs(CONTEXT);

const text = (t: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });
const mention = (userId: string, iid = `m-${userId}`): JSONContent => ({ type: ENTITY_CHIP, attrs: { kind: MENTION, iid, data: { userId } } });
const citation = (refId: string, iid = `c-${refId}`, more: Record<string, unknown> = {}): JSONContent => ({
  type: ENTITY_CHIP,
  attrs: { kind: CITATION, iid, data: { items: [{ refId, ...more }] } },
});

/** What a stored body says, instance ids aside: those are given afresh by the Markdown door. */
function withoutIids(json: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(json, (key, value) => (key === "iid" ? "" : value)));
}

/** The Markdown door end to end, the server's lookups replaced by the fixture's: write, parse, resolve, validate. */
function throughMarkdown(json: JSONContent): JSONContent {
  const markdown = commentContentToMarkdown(json, chipMarkdowns(chipsInJSON(json), COMMENT_CHIP_STYLES, CONTEXT));
  const parsed = markdownToCommentContent(markdown);
  const slugs = new Map(Object.values(CONTEXT[MENTION]).map((u) => [u.slug, u.id]));
  const resolved = { type: "doc", content: chipsForFinding(parsed.content ?? [], { user: (s) => slugs.get(s), reference: (k) => k }) ?? parsed.content };
  const result = parseCommentBody(resolved);
  assert.ok(!isCommentBodyError(result), `${markdown} → ${JSON.stringify(result)}`);
  return result.json;
}

// --- The parse ---------------------------------------------------------------

test("parse: a mention's link and the bracketed citations are read; a bare @word is text", () => {
  const [block] = markdownToCommentContent("@Andrew, see [@Ada Lovelace](/authors/ada) on [see @radner2012, p. 49; -@barfield1957].").content ?? [];
  const content = block.content ?? [];
  assert.deepEqual(content[0], text("@Andrew, see "));
  assert.equal(content[1].attrs?.kind, MENTION);
  assert.equal((content[1].attrs?.data as { slug: string }).slug, "ada");
  assert.deepEqual(content[2], text(" on "));
  assert.equal(content[3].attrs?.kind, CITATION);
  const items = (content[3].attrs?.data as { items: { key: string; prefix?: string; suppressAuthor?: boolean }[] }).items;
  assert.deepEqual(
    items.map((item) => [item.key, item.prefix ?? "", item.suppressAuthor === true]),
    [
      ["radner2012", "see", false],
      ["barfield1957", "", true],
    ],
  );
  // The narrative form is a doc's: in a comment it is what it says.
  assert.deepEqual(markdownToCommentContent("@radner2012 [p. 4] says so").content?.[0].content, [text("@radner2012 [p. 4] says so")]);
});

test("parse: an unresolved placeholder is refused by the validation, never stored", () => {
  const placeholder = markdownToCommentContent("see [@nosuchkey]");
  const result = parseCommentBody(placeholder);
  assert.ok(isCommentBodyError(result));
  assert.match(result.error, /mention or citation/);
});

// --- The writer --------------------------------------------------------------

test("writer: a chip in its kind's syntax, a bare @ as written, and nothing else reading back as a chip", () => {
  const json = doc(
    para(text("@Andrew, "), mention("u1"), text(" agrees "), citation("radner2012", "c1", { locator: "49" }), text(".")),
    para(text("[@radner2012] by hand, and "), text("@Grace", [{ type: "link", attrs: { href: "/authors/grace" } }])),
    para(citation("barfield1957"), text("(sic): noted")),
  );
  const markdown = commentContentToMarkdown(json, chipMarkdowns(chipsInJSON(json), COMMENT_CHIP_STYLES, CONTEXT));
  assert.equal(
    markdown,
    [
      "@Andrew, [@Ada Lovelace](/authors/ada) agrees [@radner2012, p. 49].",
      "",
      "\\[@radner2012\\] by hand, and [\\@Grace](/authors/grace)",
      "",
      "[@barfield1957]\\(sic): noted",
    ].join("\n"),
  );
});

test("round trip: many comment shapes read back as themselves through both front doors", () => {
  const link = (href: string) => [{ type: "link", attrs: { href } }];
  const bodies: JSONContent[] = [
    doc(para(mention("u1"))),
    doc(para(text("cc "), mention("u1"), text(" and "), mention("u2"))),
    doc(para(text("As "), citation("radner2012", "c1", { locator: "49–51", prefix: "see", suffix: "emphasis added" }), text(" argues."))),
    doc(para(citation("radner2012", "c1", { suppressAuthor: true }), text(" again"))),
    doc(para(text("two works "), { type: ENTITY_CHIP, attrs: { kind: CITATION, iid: "c3", data: { items: [{ refId: "radner2012" }, { refId: "barfield1957", locator: "4" }] } } })),
    doc(para(text("bold", [{ type: "bold" }]), text(" "), mention("u2"), text(" "), text("italic", [{ type: "italic" }]))),
    doc({ type: "bulletList", content: [{ type: "listItem", content: [para(mention("u1"), text(" first"))] }, { type: "listItem", content: [para(text("second "), citation("barfield1957"))] }] }),
    doc({ type: "blockquote", attrs: { anchorId: null }, content: [para(text("quoted "), mention("u2"))] }, para(text("reply"))),
    doc(para(text("@everyone look, "), text("a link", link("https://example.com")), text(" and "), mention("u1"))),
    doc(para(text("first@last, @handle and [brackets]"))),
    doc(para(text("code "), text("[@radner2012]", [{ type: "code" }]), text(" stays code"))),
    doc(para(mention("u1"), { type: "hardBreak" }, citation("radner2012"))),
  ];
  for (const body of bodies) {
    const stored = parseCommentBody(body);
    assert.ok(!isCommentBodyError(stored), JSON.stringify(body));
    // The rich door keeps the body as it came.
    assert.deepEqual(stored.json, JSON.parse(JSON.stringify(pmCommentContentSchema.nodeFromJSON(body).toJSON())), "rich");
    // The Markdown door, as the edit box reads and resaves it.
    assert.deepEqual(withoutIids(throughMarkdown(stored.json)), withoutIids(stored.json), commentContentToMarkdown(stored.json));
  }
});

// --- What a stored chip may be -----------------------------------------------

test("conform: each chip through its kind's validator, an unknown kind or bad fields refused", () => {
  assert.ok(isCommentBodyError(parseCommentBody(doc(para({ type: ENTITY_CHIP, attrs: { kind: MENTION, iid: "x", data: {} } })))));
  assert.ok(isCommentBodyError(parseCommentBody(doc(para({ type: ENTITY_CHIP, attrs: { kind: "future", iid: "x", data: { a: 1 } } })))));
  const kept = parseCommentBody(doc(para({ type: ENTITY_CHIP, attrs: { kind: MENTION, iid: "x", data: { userId: "u1", extra: "dropped" } } })));
  assert.ok(!isCommentBodyError(kept));
  assert.deepEqual(chipsInJSON(kept.json)[0].data, { userId: "u1" });
});

test("conform: no mark on a chip but a quotation's, and no narrative form", () => {
  const marked = { ...mention("u1"), marks: [{ type: "bold" }, { type: "quote", attrs: { anchorId: null } }, { type: "link", attrs: { href: "https://x.invalid" } }] };
  const narrative = { type: ENTITY_CHIP, attrs: { kind: CITATION, iid: "n", data: { items: [{ refId: "radner2012" }], form: "narrative" } } };
  const result = parseCommentBody(doc(para(marked, text(" "), narrative)));
  assert.ok(!isCommentBodyError(result));
  const [chip, , cited] = result.json.content?.[0].content ?? [];
  assert.deepEqual(chip.marks?.map((mark) => mark.type), ["quote"]);
  assert.deepEqual(cited.attrs?.data, { items: [{ refId: "radner2012" }] });
});

test("conform: an instance id missing or repeated is given a fresh one, the first holder keeping its own", () => {
  const result = conformCommentChips(doc(para(mention("u1", "same"), mention("u2", "same"), mention("u1", ""))));
  assert.ok(!("error" in result));
  const iids = chipsInJSON(result.json).map((chip) => chip.iid);
  assert.equal(iids[0], "same");
  assert.equal(new Set(iids).size, 3);
  assert.ok(iids.every((iid) => iid !== ""));
});

test(`conform: at most ${MAX_CHIPS_PER_COMMENT} chips`, () => {
  const chips = (n: number) => Array.from({ length: n }, (_, i) => mention("u1", `m${i}`));
  assert.ok(!isCommentBodyError(parseCommentBody(doc(para(...chips(MAX_CHIPS_PER_COMMENT))))));
  const over = parseCommentBody(doc(para(...chips(MAX_CHIPS_PER_COMMENT + 1))));
  assert.ok(isCommentBodyError(over));
  assert.match(over.error, /at most 20/);
});

test("a body that is a lone chip is not empty", () => {
  assert.ok(!isCommentBodyError(parseCommentBody(doc(para(mention("u1"))))));
});

test("the insertion check asks about every chip but those the edited comment already holds", () => {
  const held = doc(para(mention("u1"), citation("radner2012")));
  const edited = doc(para(mention("u1", "new-iid"), mention("u2"), citation("radner2012"), citation("barfield1957")));
  assert.deepEqual(freshCommentChipTargets(edited, held), { [MENTION]: ["u2"], [CITATION]: ["barfield1957"] });
  assert.deepEqual(freshCommentChipTargets(edited, null), { [MENTION]: ["u1", "u2"], [CITATION]: ["radner2012", "barfield1957"] });
});

// --- The text ----------------------------------------------------------------

test("bodyText holds labels, in the comment style whatever a doc's would be", () => {
  const node = pmCommentContentSchema.nodeFromJSON(doc(para(text("Hi "), mention("u1"), text(", see "), citation("radner2012", "c1", { locator: "49" })), para(mention("u2"))));
  assert.equal(commentBodyText(node, chipLabelsIn(node, INPUTS)), "Hi @Ada Lovelace, see (Radner 2012, p. 49)\n@Grace Hopper");
  // Without labels a chip reads as nothing, never as the doc's `short` form.
  assert.equal(commentBodyText(node), "Hi , see");
});

// --- Quoting a comment that holds a chip ------------------------------------

const source = pmCommentContentSchema.nodeFromJSON(
  doc(para(text("I think "), mention("u1"), text(" was right about engines.")), para(text("And "), citation("radner2012", "c1", { locator: "4" }), text(" agrees."))),
);
const sourceLabels = chipLabelsIn(source, INPUTS);
const target = flattenForMatch(source, sourceLabels);

test("capture: a quotation typed with a chip's label finds the chip, and one cut inside a label takes the whole chip", () => {
  const found = matchQuoteAcross([{ key: "c", target }], "@Ada Lovelace was right");
  assert.ok(found);
  assert.equal(quotedTextAt(source, found.match.from, found.match.to), `${CHIP_ANCHOR_TEXT} was right`);
  const cut = matchQuoteAcross([{ key: "c", target }], "Lovelace was right about engines");
  assert.ok(cut);
  assert.equal(cut.match.widened, true);
  assert.equal(quotedTextAt(source, cut.match.from, cut.match.to), `${CHIP_ANCHOR_TEXT} was right about engines`);
});

test("capture: the rewrite copies a passage's chips as chips with ids of their own, block and inline alike", () => {
  const reply = pmCommentContentSchema.nodeFromJSON(
    doc({ type: "blockquote", attrs: { anchorId: null }, content: [para(text("@Ada Lovelace was right about engines. And (Radner 2012, p. 4) agrees."))] }, para(text("Yes."))),
  );
  const [candidate] = extractQuoteCandidates(reply);
  const found = matchQuoteAcross([{ key: "c", target }], candidate.text);
  assert.ok(found);
  const rewritten = applyQuoteResolutions(reply, [
    { candidate, anchorId: "row", quotedText: found.match.quotedText, paragraphs: quotedContentIn(source, found.match.from, found.match.to) },
  ]);
  rewritten.check();
  const quote = rewritten.firstChild!;
  assert.equal(quote.attrs.anchorId, "row");
  assert.equal(quote.childCount, 2);
  const copied = chipsIn(rewritten);
  assert.deepEqual(copied.map((chip) => chip.kind), [MENTION, CITATION]);
  assert.ok(copied.every((chip) => chip.iid !== "" && !chipsIn(source).some((original) => original.iid === chip.iid)));
  // No U+FFFC written as text: the chips are chips.
  let written = "";
  rewritten.descendants((node) => {
    if (node.isText) written += node.text;
  });
  assert.ok(!written.includes(CHIP_ANCHOR_TEXT));
  // An inline quotation, under the quote mark, chip and all.
  const inlineReply = pmCommentContentSchema.nodeFromJSON(doc(para(text('He said "@Ada Lovelace was right about engines" so'))));
  const inline = extractQuoteCandidates(inlineReply).find((c) => c.kind === "inline")!;
  const hit = matchQuoteAcross([{ key: "c", target }], inline.text)!;
  const inlined = applyQuoteResolutions(inlineReply, [
    { candidate: inline, anchorId: "row2", quotedText: hit.match.quotedText, paragraphs: quotedContentIn(source, hit.match.from, hit.match.to) },
  ]);
  const runs = inlined.firstChild!.content.content;
  assert.deepEqual(
    runs.map((node) => [node.type.name, node.marks.map((mark) => mark.type.name)]),
    [
      ["text", []],
      ["entityChip", ["quote"]],
      ["text", ["quote"]],
      ["text", []],
    ],
  );
});

test("capture: on an edit, a quotation's copied chips read as their labels, so it matches the same passage again", () => {
  const reply = pmCommentContentSchema.nodeFromJSON(doc({ type: "blockquote", attrs: { anchorId: null }, content: [para(text("@Ada Lovelace was right about engines."))] }));
  const [first] = extractQuoteCandidates(reply);
  const found = matchQuoteAcross([{ key: "c", target }], first.text)!;
  const rewritten = applyQuoteResolutions(reply, [
    { candidate: first, anchorId: "row", quotedText: found.match.quotedText, paragraphs: quotedContentIn(source, found.match.from, found.match.to) },
  ]);
  const [again] = extractQuoteCandidates(rewritten, chipLabelsIn(rewritten, INPUTS));
  assert.equal(again.anchorId, "row");
  assert.equal(again.text, "@Ada Lovelace was right about engines.");
  const refound = matchQuoteAcross([{ key: "c", target }], again.text, { key: "c", range: { from: found.match.from, to: found.match.to } });
  assert.deepEqual([refound?.match.from, refound?.match.to], [found.match.from, found.match.to]);
});

test("capture: a quotation of a post copies text, as it always has", () => {
  const post = pmSchema.nodeFromJSON(doc(para(text("A post's own words, plain."))));
  const pieces = quotedContentIn(post, 1, post.content.size - 1);
  assert.deepEqual(pieces, [[{ text: "A post's own words, plain." }]]);
});
