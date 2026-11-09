import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import { docContentToMarkdown, escapeChipAts, markdownToAnnotationContent, markdownToBlocks, markdownToCommentContent, postContentToMarkdown } from "../../markdown-import";
import { mergeTextblock } from "../../doc-edit";
import { pmDocContentSchema } from "../../tiptap-schema";
import { chipMarkdowns, chipsIn } from "../renderings";
import { DEFAULT_CHIP_STYLES } from "../types";
import { CITATION, citationKind, type CitationContext, type CitedWork } from "./citation";
import { citationShapedAts, guardBareKey, readCitation, writeKey } from "./citation-markdown";

// docs/CITATIONS.md, "Markdown" — a citation in Pandoc's syntax: what the
// parse reads as one, and what the writer escapes so that a read sent back
// unchanged is the same doc.

// --- reading ---------------------------------------------------------------

test("read: each of Pandoc's forms", () => {
  assert.deepEqual(readCitation("[see @radner2012, p. 49; @barfield1957] and on", undefined), {
    raw: "[see @radner2012, p. 49; @barfield1957]",
    items: [{ key: "radner2012", prefix: "see", suffix: "p. 49" }, { key: "barfield1957" }],
    narrative: false,
  });
  assert.deepEqual(readCitation("[-@radner2012]", undefined)?.items, [{ key: "radner2012", suppressAuthor: true }]);
  assert.deepEqual(readCitation("@radner2012 [p. 49] says", " "), {
    raw: "@radner2012 [p. 49]",
    items: [{ key: "radner2012", suffix: "p. 49" }],
    narrative: true,
  });
  assert.deepEqual(readCitation("@{radner2012}-style", "e"), { raw: "@{radner2012}", items: [{ key: "radner2012" }], narrative: true });
});

test("read: where a bare key ends, and where an @ is no citation", () => {
  // Trailing punctuation ends the key; internal punctuation doesn't.
  assert.equal(readCitation("@radner2012. Next", undefined)?.raw, "@radner2012");
  assert.equal(readCitation("@radner2012-style", undefined)?.raw, "@radner2012-style");
  // After a letter or digit, as in an address; a braced key is read anyway.
  assert.equal(readCitation("@example.com", "e"), null);
  assert.ok(readCitation("@{example}", "e"));
  // No key after the @.
  assert.equal(readCitation("@ home", " "), null);
  assert.equal(readCitation("@", undefined), null);
});

test("read: a bracket is a citation only when every part names a key, and no ( follows", () => {
  assert.equal(readCitation("[see @x](https://example.com)", undefined), null);
  assert.equal(readCitation("[@x; and more]", undefined), null);
  assert.equal(readCitation("[foo@x]", undefined), null);
  assert.equal(readCitation("[a [@x] b]", undefined), null);
  assert.equal(readCitation("[@x", undefined), null);
  // A narrative citation's bracket holds no key, or it is a citation of its own.
  assert.equal(readCitation("@a [@b]", undefined)?.raw, "@a");
  // Escaped delimiters are the fields' own.
  assert.deepEqual(readCitation("[see\\; also @x, p. 4\\]]", undefined)?.items, [{ key: "x", prefix: "see; also", suffix: "p. 4]" }]);
});

// --- the parse -------------------------------------------------------------

const inline = (markdown: string): JSONContent[] => markdownToBlocks(markdown, { chips: true })[0].content ?? [];
const shape = (nodes: JSONContent[]) =>
  nodes.map((node) =>
    node.type === "entityChip"
      ? `${String(node.attrs?.kind)}:${JSON.stringify((node.attrs?.data as { items?: unknown }).items ?? (node.attrs?.data as { slug: string }).slug)}`
      : `${node.text}${node.marks?.length ? `|${node.marks.map((mark) => mark.type).join(",")}` : ""}`,
  );

test("parse: a citation is a placeholder holding its keys, and a mention is still a mention", () => {
  assert.deepEqual(shape(inline("As @radner2012 [p. 49] said, see [@barfield1957; -@radner2012].")), [
    "As ",
    `citation:${JSON.stringify([{ key: "radner2012", suffix: "p. 49" }])}`,
    " said, see ",
    `citation:${JSON.stringify([{ key: "barfield1957" }, { key: "radner2012", suppressAuthor: true }])}`,
    ".",
  ]);
  const [narrative] = inline("@radner2012 [p. 49]");
  assert.equal((narrative.attrs?.data as { form?: string }).form, "narrative");
  assert.deepEqual(shape(inline("Ask [@Ada Lovelace](/authors/ada).")), ["Ask ", 'mention:"ada"', "."]);
});

test("parse: nothing in code, link text, an address or an escape is a citation", () => {
  assert.deepEqual(shape(inline("`@radner2012`")), ["@radner2012|code"]);
  assert.deepEqual(shape(inline("[@handle](https://x.com/handle)")), ["@handle|link"]);
  assert.deepEqual(shape(inline("[see @x and more](https://example.com)")), ["see @x and more|link"]);
  assert.deepEqual(shape(inline("mail luke@example.com")), ["mail ", "luke@example.com|link"]);
  assert.deepEqual(shape(inline("\\@radner2012 and \\[\\@x\\]")), ["@radner2012 and [@x]"]);
});

test("parse: a note's body reads citations too, and a comment's reads only the bracketed forms", () => {
  const note = markdownToAnnotationContent("see [@x, p. 4]", { chips: true });
  assert.equal(note.content?.[0].content?.[1].attrs?.kind, CITATION);
  // A comment's bare @word is how one commenter addresses another (docs/ENTITY_CHIPS.md, "Planned: chips in comments").
  const comment = markdownToCommentContent("@Andrew, see [@x]").content?.[0].content;
  assert.deepEqual(comment?.[0], { type: "text", text: "@Andrew, see " });
  assert.equal(comment?.[1].attrs?.kind, CITATION);
  assert.deepEqual(markdownToCommentContent("@radner2012 [p. 4] and @{x}").content?.[0].content, [{ type: "text", text: "@radner2012 [p. 4] and @{x}" }]);
  // A parse without chips has a marked instance with no citation tokenizer on it.
  assert.deepEqual(shape(markdownToBlocks("@Andrew, see this")[0].content ?? []), ["@Andrew, see this"]);
});

test("escapeChipAts: no @ reads as a chip, and the text parses as it would without chips", () => {
  // As a doc holds it: adjacent text nodes with the same marks joined.
  const plain = (markdown: string, chips: boolean) =>
    markdownToBlocks(markdown, { chips }).map((block) => pmDocContentSchema.nodeFromJSON(block).toJSON());
  const cases = [
    "npm i -D @playwright/test, then ask @Andrew",
    "see [@radner2012, p. 49; -@barfield1957] and @radner2012 [p. 49]",
    "Ask [@Ada Lovelace](/authors/ada) or see@{radner2012}",
    "keep `@code` and \\@escaped, mail luke@example.com",
    "<https://x.com/@a> and https://medium.com/@user/post and [a page](https://x.com/@b)",
    "| @a | b |\n| - | - |\n| c | @d |",
  ];
  for (const markdown of cases) {
    const escaped = escapeChipAts(markdown);
    assert.deepEqual(plain(escaped, true), plain(markdown, false), markdown);
  }
  // Only what would read as a chip changes: an address, a URL and code don't.
  assert.equal(escapeChipAts("keep `@code`, luke@example.com, https://x.com/@a"), "keep `@code`, luke@example.com, https://x.com/@a");
  assert.equal(escapeChipAts("[-@k] see@{k} \\@k"), "[-\\@k] see\\@{k} \\@k");
});

// --- writing ---------------------------------------------------------------

test("write: a key that wouldn't read back bare is braced, and so is one its neighbours would change", () => {
  assert.equal(writeKey("radner2012"), "@radner2012");
  assert.equal(writeKey("radner-"), "@{radner-}");
  assert.equal(guardBareKey("@radner2012", "e", " says"), "@{radner2012}");
  assert.equal(guardBareKey("@radner2012", " ", "-style"), "@{radner2012}");
  assert.equal(guardBareKey("@radner2012", " ", ". Next"), "@radner2012");
  assert.equal(guardBareKey("@radner2012 [p. 4]", "e", ""), "@{radner2012} [p. 4]");
  assert.equal(guardBareKey("[@radner2012]", "e", "-x"), "[@radner2012]");
});

test("write: the @s that would read as a citation", () => {
  assert.deepEqual(citationShapedAts("@a, luke@example.com, (@b), @ c, x@{d}"), [0, 23, 34]);
});

const work = (id: string, key: string, more: Partial<CitedWork> = {}): CitedWork => ({
  id,
  key,
  short: null,
  names: "Radner",
  year: 2012,
  title: "Origin",
  deleted: false,
  entry: { authors: "Radner, D.", year: "2012", title: "Origin", titleIsContainer: true, source: "" },
  ...more,
});
const CONTEXT: CitationContext = {
  r1: work("r1", "radner2012"),
  r2: work("r2", "barfield1957", { short: "BU" }),
  r3: work("r3", "odd-"),
  gone: work("gone", "gone1999", { deleted: true }),
};
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const cite = (iid: string, data: Record<string, unknown>): JSONContent => ({ type: "entityChip", attrs: { kind: CITATION, iid, data } });
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

/** `doc` written as a read writes it, and parsed back as an edit would parse it. */
function roundTrip(...content: JSONContent[]) {
  const doc = pmDocContentSchema.nodeFromJSON({ type: "doc", content: [para(...content)] });
  const markdown = docContentToMarkdown(doc.toJSON(), chipMarkdowns(chipsIn(doc), DEFAULT_CHIP_STYLES, { [CITATION]: CONTEXT }));
  return { markdown, back: shape(inline(markdown)) };
}

test("round trip: every field, in every form, reads back as the keys it was written with", () => {
  const { markdown, back } = roundTrip(
    text("See "),
    cite("a", { items: [{ refId: "r1", locator: "49–51", prefix: "cf.; also", suffix: "n. 3" }, { refId: "r2", suppressAuthor: true }] }),
    text(" and "),
    cite("b", { items: [{ refId: "r1", locator: "4" }], form: "narrative" }),
    text(", "),
    cite("c", { items: [{ refId: "r3" }] }),
    text(", "),
    cite("d", { items: [{ refId: "gone" }] }),
    text("."),
  );
  assert.equal(markdown, "See [cf.\\; also @radner2012, pp. 49–51, n. 3; -@barfield1957] and @radner2012 [p. 4], [@{odd-}], ~~[@gone1999]~~.");
  assert.deepEqual(back, [
    "See ",
    `citation:${JSON.stringify([{ key: "radner2012", prefix: "cf.; also", suffix: "pp. 49–51, n. 3" }, { key: "barfield1957", suppressAuthor: true }])}`,
    " and ",
    `citation:${JSON.stringify([{ key: "radner2012", suffix: "p. 4" }])}`,
    ", ",
    `citation:${JSON.stringify([{ key: "odd-" }])}`,
    ", ",
    `citation:${JSON.stringify([{ key: "gone1999" }])}`,
    ".",
  ]);
});

test("round trip: text that reads like a citation stays text", () => {
  const { markdown, back } = roundTrip(text("Write @radner2012 or [@radner2012], mail luke@example.com, keep `"), text("@code", [{ type: "code" }]), text("`."));
  assert.equal(markdown, "Write \\@radner2012 or \\[\\@radner2012\\], mail luke@example.com, keep \\``@code`\\`.");
  assert.deepEqual(back.filter((piece) => piece.startsWith("citation")), []);
  assert.equal(back[0], "Write @radner2012 or [@radner2012], mail ");
  assert.equal(back[1], "luke@example.com|link");
});

test("round trip: text beside a citation can't change it", () => {
  const bracketed = cite("a", { items: [{ refId: "r1" }] });
  const bare = cite("b", { items: [{ refId: "r1" }], form: "narrative" });
  // `(` after a bracket would make it a link, and `:` opening a paragraph a definition.
  const link = roundTrip(bracketed, text("(sic)"));
  assert.equal(link.markdown, "[@radner2012]\\(sic)");
  assert.deepEqual(link.back, [`citation:${JSON.stringify([{ key: "radner2012" }])}`, "(sic)"]);
  const definition = roundTrip(bracketed, text(": agreed."));
  assert.deepEqual(definition.back, [`citation:${JSON.stringify([{ key: "radner2012" }])}`, ": agreed."]);
  // A letter before a bare key, or key characters after it.
  assert.deepEqual(roundTrip(text("see"), bare, text("-style")).back, ["see", `citation:${JSON.stringify([{ key: "radner2012" }])}`, "-style"]);
});

test("round trip: a mark that stops at a chip leaves its space outside, where the writer puts it", () => {
  // A chip carries no mark, so each of these marks stops at one with a space against it.
  const merged = (markdown: string) => shape(pmDocContentSchema.nodeFromJSON(markdownToBlocks(markdown, { chips: true })[0]).toJSON().content ?? []);
  const k = `citation:${JSON.stringify([{ key: "radner2012" }])}`;
  const read = merged("**see [@radner2012]**, *[@radner2012] opens* and ~~[@radner2012] [@radner2012]~~.");
  assert.deepEqual(read, ["see|bold", " ", k, ", ", k, " ", "opens|italic", " and ", k, " ", k, "."]);
  // The doc that parse makes writes and reads back as itself.
  const chip = (iid: string) => cite(iid, { items: [{ refId: "r1" }] });
  const { markdown, back } = roundTrip(
    text("see", [{ type: "bold" }]),
    text(" "),
    chip("a"),
    text(", "),
    chip("b"),
    text(" "),
    text("opens", [{ type: "italic" }]),
    text(" and "),
    chip("c"),
    text(" "),
    chip("d"),
    text("."),
  );
  assert.equal(markdown, "**see** [@radner2012], [@radner2012] *opens* and [@radner2012] [@radner2012].");
  assert.deepEqual(back, read);
  // A note's body is parsed the same way.
  const note = markdownToAnnotationContent("**see [@radner2012]**", { chips: true }).content?.[0].content ?? [];
  assert.deepEqual(shape(note), ["see|bold", " ", k]);
});

test("round trip: Markdown inside a citation's words, escapes and delimiters included", () => {
  const fields = [
    { prefix: "see *especially*", suffix: "**emphasis** added" },
    { prefix: "\\*not italic\\*", suffix: "a `code; span` and [sic]" },
    { prefix: "x; y @z", suffix: "ends in \\\\" },
    { prefix: "a \\\\ b" },
  ];
  for (const field of fields) {
    const stored = citationKind.validate({ items: [{ refId: "r1", ...field }] })!;
    const doc = pmDocContentSchema.nodeFromJSON({ type: "doc", content: [para(cite("a", stored))] });
    const markdown = docContentToMarkdown(doc.toJSON(), chipMarkdowns(chipsIn(doc), DEFAULT_CHIP_STYLES, { [CITATION]: CONTEXT }));
    const [read] = inline(markdown);
    assert.equal(read.type, "entityChip", markdown);
    // The placeholder holds what the Markdown wrote; the validator stores it as the chip did.
    const [item] = (read.attrs?.data as { items: Record<string, unknown>[] }).items;
    const back = citationKind.validate({ items: [{ refId: "r1", prefix: item.prefix, suffix: item.suffix }] })!;
    assert.deepEqual(back, stored, markdown);
  }
});

test("a post's Markdown escapes a label's @, so create_doc reads it back as text", () => {
  const markdown = postContentToMarkdown({ type: "doc", content: [para(text("Ask @Ada Lovelace."))] });
  assert.equal(markdown, "Ask \\@Ada Lovelace.");
  assert.deepEqual(shape(inline(markdown)), ["Ask @Ada Lovelace."]);
});

// --- the merge -------------------------------------------------------------

test("merge: an edit that changes a citation's page keeps the chip, and takes the page", () => {
  const old = pmDocContentSchema.node("paragraph", null, [
    pmDocContentSchema.text("As "),
    pmDocContentSchema.nodes.entityChip.create({ kind: CITATION, iid: "keep", data: { items: [{ refId: "r1", locator: "49" }] } }),
    pmDocContentSchema.text(" said."),
  ]);
  const next = pmDocContentSchema.node("paragraph", null, [
    pmDocContentSchema.text("As "),
    pmDocContentSchema.nodes.entityChip.create({ kind: CITATION, iid: "fresh", data: { items: [{ refId: "r1", locator: "50" }] } }),
    pmDocContentSchema.text(" said."),
  ]);
  const merged = mergeTextblock(old, next, { schema: pmDocContentSchema, authorId: null });
  const chip = merged.child(1);
  assert.equal(chip.attrs.iid, "keep");
  assert.deepEqual(chip.attrs.data, { items: [{ refId: "r1", locator: "50" }] });
});
