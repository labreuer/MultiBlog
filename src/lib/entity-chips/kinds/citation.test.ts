import { test } from "node:test";
import assert from "node:assert/strict";
import { citationKind, normalizeLocator, UNKNOWN_WORK, type CitationContext, type CitationData, type CitedWork } from "./citation";

// docs/CITATIONS.md — the citation chip kind: what it stores, and what each
// form shows for it.

const work = (id: string, more: Partial<CitedWork> = {}): CitedWork => {
  const fields = { id, key: id, short: null, names: "Radner", year: 2012, title: "The Origin of Ideas", deleted: false, file: null, ...more };
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
  // A post's reader is sent to the reference's page, the page cited in the fragment.
  assert.deepEqual(live, { label: "(BU pp. 49–51)", href: "/references/barfield1957", postHref: "/references/barfield1957#p=49", status: "live" });
});

test("a doc's link goes to the page in the PDF, by the file's page labels, when it has both", () => {
  const withFile: CitationContext = { bu: { ...CONTEXT.bu, file: { slug: "saving", pageLabels: ["i", "ii", "1", "2", "49"] } } };
  const href = (locator?: string) => citationKind.render([cite("bu", locator ? { locator } : {})], { form: "short" }, withFile)[0].href;
  assert.equal(href("49"), "/pdf/saving#page=5");
  assert.equal(href("ii"), "/pdf/saving#page=2");
  // A page the file doesn't label, and no page at all: the reference's own page.
  assert.equal(href("300"), "/references/barfield1957");
  assert.equal(href(), "/references/barfield1957");
  // With no labels, a number is the sheet.
  const unlabelled: CitationContext = { bu: { ...CONTEXT.bu, file: { slug: "saving", pageLabels: null } } };
  assert.equal(citationKind.render([cite("bu", { locator: "49" })], { form: "short" }, unlabelled)[0].href, "/pdf/saving#page=49");
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
