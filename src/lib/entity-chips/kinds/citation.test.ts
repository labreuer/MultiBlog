import { test } from "node:test";
import assert from "node:assert/strict";
import { citationKind, isPageLocator, normalizeLocator, pdfPageHref, splitTrailingPages, UNKNOWN_WORK, type CitationContext, type CitationData, type CitedWork } from "./citation";

// docs/CITATIONS.md — the citation chip kind: what it stores, and what each
// form shows for it.

const work = (id: string, more: Partial<CitedWork> = {}): CitedWork => {
  const fields = { id, key: id, short: null, names: "Radner", year: 2012, title: "The Origin of Ideas", deleted: false, ...more };
  // The entry as the context loader makes one, from the same record.
  const entry = { authors: fields.names, year: fields.year === null ? "n.d." : String(fields.year), title: fields.title, titleIsContainer: true, source: "" };
  return { entry, ...fields };
};
const CONTEXT: CitationContext = {
  bu: work("bu", { key: "barfield1957", short: "BU", names: "Barfield", year: 1957, title: "Saving the Appearances" }),
  radner: work("radner", { key: "radner2012" }),
  anon: work("anon", { key: "beowulf", names: "", year: null, title: "Beowulf" }),
  gone: work("gone", { key: "gone1999", short: "GN", deleted: true }),
};
const cite = (refId: string, more: Record<string, unknown> = {}): CitationData => ({ items: [{ refId, ...more }] });
const label = (data: CitationData, form: "short" | "author-date" | "numeric" = "short") => citationKind.render([data], { form }, CONTEXT)[0].label;
const narrative = (refId: string, more: Record<string, unknown> = {}): CitationData => ({ items: [{ refId, ...more }], form: "narrative" });

test("each form: parenthetical, narrative, and with the author suppressed", () => {
  const p49 = { locator: "49" };
  assert.equal(label(cite("bu", p49)), "(BU p. 49)");
  assert.equal(label(narrative("bu", p49)), "BU (p. 49)");
  assert.equal(label(cite("bu", { ...p49, suppressAuthor: true })), "(p. 49)");

  assert.equal(label(cite("radner", p49), "author-date"), "(Radner 2012, p. 49)");
  assert.equal(label(narrative("radner", p49), "author-date"), "Radner (2012, p. 49)");
  assert.equal(label(cite("radner", { ...p49, suppressAuthor: true }), "author-date"), "(2012, p. 49)");

  assert.equal(label(cite("radner", p49), "numeric"), "[1, p. 49]");
  assert.equal(label(narrative("radner", p49), "numeric"), "Radner [1, p. 49]");
  // No effect in a numeric citation, as in citeproc.
  assert.equal(label(cite("radner", { ...p49, suppressAuthor: true }), "numeric"), "[1, p. 49]");
});

test("a page range, no page at all, a prefix, a suffix and several works", () => {
  assert.equal(label(cite("bu", { locator: "49–51" })), "(BU pp. 49–51)");
  assert.equal(label(cite("bu")), "(BU)");
  assert.equal(label(narrative("radner"), "author-date"), "Radner (2012)");
  assert.equal(
    label({ items: [{ refId: "radner", locator: "49", prefix: "see" }, { refId: "bu", suffix: "emphasis added" }] }, "author-date"),
    "(see Radner 2012, p. 49; Barfield 1957, emphasis added)",
  );
  // A work with no creator is cited by its title, and an undated one says so.
  assert.equal(label(cite("anon", { locator: "3" }), "author-date"), "(Beowulf n.d., p. 3)");
});

test("a reference with no abbreviation falls back to author-date in the short form", () => {
  assert.equal(label(cite("radner", { locator: "49" })), "(Radner 2012, p. 49)");
  assert.equal(label(narrative("radner", { locator: "49" })), "Radner (2012, p. 49)");
  assert.equal(label({ items: [{ refId: "bu", locator: "49" }, { refId: "radner" }] }), "(BU p. 49; Radner 2012)");
});

test("numeric citations are numbered by first appearance across the doc", () => {
  const rendered = citationKind.render([cite("bu"), cite("radner"), { items: [{ refId: "radner", locator: "5" }, { refId: "bu" }] }, cite("anon")], { form: "numeric" }, CONTEXT);
  assert.deepEqual(
    rendered.map((r) => r.label),
    ["[1]", "[2]", "[2, p. 5; 1]", "[3]"],
  );
});

test("two works sharing an abbreviation are told apart by year, then by key", () => {
  const context: CitationContext = {
    a: work("a", { key: "a1957", short: "BU", year: 1957 }),
    b: work("b", { key: "b2012", short: "BU", year: 2012 }),
    c: work("c", { key: "c2012", short: "BU", year: 2012 }),
  };
  const two = citationKind.render([cite("a"), cite("b")], { form: "short" }, context);
  assert.deepEqual(two.map((r) => r.label), ["(BU 1957)", "(BU 2012)"]);
  const three = citationKind.render([cite("a"), cite("b"), cite("c")], { form: "short" }, context);
  assert.deepEqual(three.map((r) => r.label), ["(BU 1957)", "(BU 2012 b2012)", "(BU 2012 c2012)"]);
  // Alone in its doc, no qualifier.
  assert.equal(citationKind.render([cite("a")], { form: "short" }, context)[0].label, "(BU)");
});

test("a deleted reference keeps its label, unlinked; an unknown one is a placeholder", () => {
  const [deleted, unknown, live] = citationKind.render([cite("gone", { locator: "4" }), cite("nobody"), cite("bu", { locator: "49–51" })], { form: "short" }, CONTEXT);
  assert.deepEqual(deleted, { label: "(GN p. 4)", href: null, postHref: null, status: "deleted" });
  assert.deepEqual(unknown, { label: UNKNOWN_WORK, href: null, postHref: null, status: "unknown" });
  // Every reader, of a doc or a post, gets the route that decides where the page cited is when it is followed.
  assert.deepEqual(live, { label: "(BU pp. 49–51)", href: "/references/barfield1957/p/49", postHref: "/references/barfield1957/p/49", status: "live" });
});

test("a citation links to its first work's page route, by the first page cited, or to the reference's page", () => {
  const href = (locator?: string) => citationKind.render([cite("bu", locator ? { locator } : {})], { form: "short" }, CONTEXT)[0].href;
  assert.equal(href("49"), "/references/barfield1957/p/49");
  assert.equal(href("49, 51"), "/references/barfield1957/p/49");
  assert.equal(href("xii"), "/references/barfield1957/p/xii");
  assert.equal(href(), "/references/barfield1957");
});

// docs/CITATIONS.md, "The link" — several works link to the page listing them, each work's page by its place.
test("a citation of several works links to the list, each work once, at the first page of the first item naming it that has one", () => {
  const href = (...items: { refId: string; locator?: string }[]) => citationKind.render([{ items }], { form: "short" }, CONTEXT)[0].href;
  // One work, cited once or twice, links to that work alone.
  assert.equal(href({ refId: "bu" }, { refId: "bu" }), "/references/barfield1957");
  assert.equal(href({ refId: "bu", locator: "49" }, { refId: "bu", locator: "51" }), "/references/barfield1957/p/49");
  assert.equal(href({ refId: "bu" }, { refId: "bu", locator: "51" }), "/references/barfield1957/p/51");
  // Several: no pages, no fragment.
  assert.equal(href({ refId: "bu" }, { refId: "radner" }, { refId: "anon" }), "/references/barfield1957,radner2012,beowulf");
  // A page on the first, and on the last alone; the first page of a range.
  assert.equal(href({ refId: "bu", locator: "12–14" }, { refId: "radner" }, { refId: "anon" }), "/references/barfield1957,radner2012,beowulf#p=12");
  assert.equal(href({ refId: "bu" }, { refId: "radner" }, { refId: "anon", locator: "3" }), "/references/barfield1957,radner2012,beowulf#p=,,3");
  assert.equal(href({ refId: "bu", locator: "xii" }, { refId: "radner" }, { refId: "anon", locator: "3" }), "/references/barfield1957,radner2012,beowulf#p=xii,,3");
  // A work named twice keeps its first place, and takes the page of its second item when its first has none.
  assert.equal(href({ refId: "bu" }, { refId: "radner" }, { refId: "bu", locator: "51" }), "/references/barfield1957,radner2012#p=51");
  // A key holding `:` is encoded, and the comma between keys is not.
  const colon: CitationContext = { ...CONTEXT, c: work("c", { key: "a:b" }) };
  assert.equal(citationKind.render([{ items: [{ refId: "c" }, { refId: "bu" }] }], { form: "short" }, colon)[0].href, "/references/a%3Ab,barfield1957");
});

test("the route finds the page cited in the PDF by the file's page labels", () => {
  const labelled = { slug: "saving", pageLabels: ["i", "ii", "1", "2", "49"] };
  assert.equal(pdfPageHref(labelled, "49"), "/pdf/saving#page=5");
  assert.equal(pdfPageHref(labelled, "ii"), "/pdf/saving#page=2");
  assert.equal(pdfPageHref(labelled, "49–51"), "/pdf/saving#page=5");
  assert.equal(pdfPageHref(labelled, "49, 60"), "/pdf/saving#page=5");
  // A page the file doesn't label, or no page: nothing to go to in the PDF.
  assert.equal(pdfPageHref(labelled, "300"), null);
  assert.equal(pdfPageHref(labelled, undefined), null);
  // With no labels, a number is the sheet.
  assert.equal(pdfPageHref({ slug: "saving", pageLabels: null }, "49"), "/pdf/saving#page=49");
  assert.equal(pdfPageHref({ slug: "saving", pageLabels: null }, "xii"), null);
  // As a file with no labels stores them once its metadata is read.
  assert.equal(pdfPageHref({ slug: "saving", pageLabels: [] }, "49"), "/pdf/saving#page=49");
  // But not past the file's last sheet.
  assert.equal(pdfPageHref({ slug: "saving", pageLabels: null, pageCount: 40 }, "49"), null);
  assert.equal(pdfPageHref({ slug: "saving", pageLabels: null, pageCount: 49 }, "49"), "/pdf/saving#page=49");
});

test("Page holds pages only, and an item is stored as Markdown reads it back", () => {
  const item = (fields: Record<string, unknown>) => citationKind.validate({ items: [{ refId: "r", ...fields }] })?.items[0];
  // Pages: digits, well-formed Roman numerals, ranges and lists.
  for (const [typed, stored] of [["49", "49"], ["p. 49", "49"], ["49-51", "49–51"], ["xii", "xii"], ["XIV", "XIV"], ["49,51", "49, 51"], ["pp. 33-35, 38", "33–35, 38"]]) {
    assert.deepEqual(item({ locator: typed }), { refId: "r", locator: stored }, typed);
    assert.equal(isPageLocator(typed), true, typed);
  }
  // Pages, then more: the rest goes after them.
  assert.deepEqual(item({ locator: "49 n. 3" }), { refId: "r", locator: "49", suffix: "n. 3" });
  assert.deepEqual(item({ locator: "49 n. 3", suffix: "emphasis added" }), { refId: "r", locator: "49", suffix: "n. 3, emphasis added" });
  // No page first: all of it goes after the work, so no label writes "p." before it.
  assert.deepEqual(item({ locator: "ch. 3" }), { refId: "r", suffix: "ch. 3" });
  assert.deepEqual(item({ locator: "§ 4" }), { refId: "r", suffix: "§ 4" });
  for (const word of ["mild", "did", "civil", "iiii"]) assert.deepEqual(item({ locator: word }), { refId: "r", suffix: word }, word);
  // Words after that are pages join the pages, as Markdown reads them.
  assert.deepEqual(item({ locator: "49", suffix: "51" }), { refId: "r", locator: "49, 51" });
  assert.deepEqual(item({ locator: "49", suffix: "51st edition" }), { refId: "r", locator: "49", suffix: "51st edition" });
  assert.deepEqual(item({ suffix: "p. 49 n. 3" }), { refId: "r", suffix: "p. 49 n. 3" });
  // What the writer writes for each reads back as the item stored.
  for (const fields of [{ locator: "49 n. 3" }, { locator: "ch. 3" }, { locator: "49", suffix: "51" }, { locator: "49, 51", suffix: "i.e. both" }, { suffix: "emphasis *added*" }]) {
    const stored = item(fields)!;
    const markdown = citationKind.markdown({ items: [stored] }, citationKind.render([{ items: [stored] }], { form: "short" }, { r: work("r") })[0], { r: work("r") });
    const after = /^\[@r(?:, (.*))?\]$/.exec(markdown)?.[1];
    assert.deepEqual(item({ suffix: after }), stored, JSON.stringify(fields));
  }
  assert.deepEqual(splitTrailingPages("radner 49"), { words: "radner", locator: "49" });
  assert.deepEqual(splitTrailingPages("radner pp. 49-51, 60"), { words: "radner", locator: "49–51, 60" });
  assert.deepEqual(splitTrailingPages("radner origin"), { words: "radner origin", locator: null });
});

test("validation stores only what the Markdown can write, in the form it reads back as", () => {
  // A suffix that reads as a locator becomes one, and a hyphen in a range an en dash.
  assert.deepEqual(citationKind.validate({ items: [{ refId: "r", suffix: "p. 5, note" }] }), { items: [{ refId: "r", locator: "5", suffix: "note" }] });
  assert.deepEqual(citationKind.validate({ items: [{ refId: "r", locator: "pp. 49-51" }] }), { items: [{ refId: "r", locator: "49–51" }] });
  // Narrative holds one work, no prefix, author shown: anything else is stored parenthetical.
  assert.deepEqual(citationKind.validate({ items: [{ refId: "r" }], form: "narrative" }), { items: [{ refId: "r" }], form: "narrative" });
  assert.deepEqual(citationKind.validate({ items: [{ refId: "r" }, { refId: "q" }], form: "narrative" }), { items: [{ refId: "r" }, { refId: "q" }] });
  assert.deepEqual(citationKind.validate({ items: [{ refId: "r", prefix: "see" }], form: "narrative" }), { items: [{ refId: "r", prefix: "see" }] });
  // Unknown fields are dropped; a chip with no work, or a malformed one, is not a citation.
  assert.deepEqual(citationKind.validate({ items: [{ refId: "r", extra: 1, suppressAuthor: "yes" }], more: true }), { items: [{ refId: "r" }] });
  for (const bad of [null, {}, { items: [] }, { items: [{}] }, { items: [{ refId: "" }] }, { items: "r" }, { items: [{ refId: "r" }, null] }]) {
    assert.equal(citationKind.validate(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeLocator(" pp. 12 -- 14 "), "12–14");
});

test("identity is the works, in any order; a citation holding every work of an old one continues it", () => {
  const ab: CitationData = { items: [{ refId: "a", locator: "1" }, { refId: "b" }] };
  const ba: CitationData = { items: [{ refId: "b" }, { refId: "a", locator: "99" }] };
  assert.equal(citationKind.identity(ab), citationKind.identity(ba));
  assert.notEqual(citationKind.identity(ab), citationKind.identity(cite("a")));
  assert.deepEqual(citationKind.targets(ab), ["a", "b"]);
  // Adding a work continues the chip; removing one does not.
  assert.equal(citationKind.continues(cite("a"), ab), true);
  assert.equal(citationKind.continues(ab, cite("a")), false);
  // What a stored record citing a work is found by: one item naming it, among however many.
  assert.deepEqual(citationKind.naming("a"), { items: [{ refId: "a" }] });
});

test("Markdown is Pandoc's syntax, by key, with every field", () => {
  const md = (data: CitationData) => citationKind.markdown(data, citationKind.render([data], { form: "numeric" }, CONTEXT)[0], CONTEXT);
  assert.equal(md(cite("radner", { locator: "49" })), "[@radner2012, p. 49]");
  assert.equal(md({ items: [{ refId: "radner", locator: "49", prefix: "see" }, { refId: "bu", suffix: "emphasis added" }] }), "[see @radner2012, p. 49; @barfield1957, emphasis added]");
  assert.equal(md(cite("radner", { suppressAuthor: true })), "[-@radner2012]");
  assert.equal(md(narrative("radner", { locator: "49–51" })), "@radner2012 [pp. 49–51]");
  assert.equal(md(narrative("radner")), "@radner2012");
  // A work that is gone is struck through, and one that is unknown carries its stored id.
  assert.equal(md(cite("gone")), "~~[@gone1999]~~");
  assert.equal(md(cite("nobody")), "~~[@nobody]~~");
});

// docs/CITATIONS.md, "Markdown inside a citation".

test("words before and after a work are Markdown: the label is their text, the runs their formatting", () => {
  const [rendering] = citationKind.render([cite("bu", { prefix: "see *especially*", locator: "49", suffix: "**emphasis** added" })], { form: "short" }, CONTEXT);
  assert.equal(rendering.label, "(see especially BU p. 49, emphasis added)");
  assert.deepEqual(rendering.runs, [
    { text: "(see " },
    { text: "especially", marks: ["italic"] },
    { text: " BU p. 49, " },
    { text: "emphasis", marks: ["bold"] },
    { text: " added)" },
  ]);
  // Every form reads them so, the narrative one's words after included.
  const numeric = citationKind.render([cite("bu", { prefix: "`cf.`" })], { form: "numeric" }, CONTEXT)[0];
  assert.deepEqual(numeric.runs, [{ text: "[" }, { text: "cf.", marks: ["code"] }, { text: " 1]" }]);
  assert.equal(citationKind.render([narrative("radner", { suffix: "~~not~~ so" })], { form: "author-date" }, CONTEXT)[0].label, "Radner (2012, not so)");
  // With no formatting there are no runs: the label says it all.
  assert.equal(citationKind.render([cite("bu", { prefix: "see" })], { form: "short" }, CONTEXT)[0].runs, undefined);
  // An escape shows its character, and each field's Markdown is its own: an unclosed `*` doesn't reach the next.
  assert.equal(label(cite("bu", { prefix: "\\*not\\* *a", suffix: "b*" })), "(*not* *a BU, b*)");
});

test("a word field is stored as Markdown with every escape but a delimiter's", () => {
  const stored = (prefix: string) => citationKind.validate({ items: [{ refId: "bu", prefix }] })?.items[0].prefix;
  // A delimiter means nothing inside the field, so it is kept bare; Markdown's own escapes stay.
  assert.equal(stored("see \\[sic\\] \; also \\@x"), "see [sic] ; also @x");
  assert.equal(stored("\\*literal\\* and *em*"), "\\*literal\\* and *em*");
  // A trailing backslash is doubled, so it can't escape what the writer puts after the field.
  assert.equal(stored("ends in \\"), "ends in \\\\");
  // Stored twice, the same.
  assert.equal(citationKind.validate(citationKind.validate({ items: [{ refId: "bu", prefix: "a\; b \\\\ c\\" }] })!)?.items[0].prefix, "a; b \\\\ c\\\\");
});
