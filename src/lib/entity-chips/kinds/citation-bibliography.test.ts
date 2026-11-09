import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReferenceEntry } from "../../references/entry";
import { MENTION } from "./mention";
import { CITATION, citationKind, type CitationContext, type CitationForm, type CitedWork } from "./citation";
import { bibliographyContent, citationBibliography } from "./citation-bibliography";
import type { ChipOccurrence } from "../types";

// docs/CITATIONS.md, "The bibliography" — the works a doc cites, in its
// style's order, numbered as its labels number them.

const entry = (authors: string, year: string, title: string, more: Partial<ReferenceEntry> = {}): ReferenceEntry => ({
  authors,
  year,
  title,
  titleIsContainer: true,
  source: "",
  ...more,
});
const work = (id: string, fields: Omit<CitedWork, "id" | "deleted" | "file"> & { deleted?: boolean }): CitedWork => ({
  id,
  deleted: false,
  ...fields,
});
const CONTEXT: CitationContext = {
  radner: work("radner", { key: "radner2012", short: null, names: "Radner", year: 2012, title: "Origin", entry: entry("Radner, D.", "2012", "The Origin of Ideas") }),
  bu: work("bu", { key: "barfield1957", short: "BU", names: "Barfield", year: 1957, title: "Saving", entry: entry("Barfield, O.", "1957", "Saving the Appearances") }),
  bu2: work("bu2", { key: "barfield1965", short: "BU", names: "Barfield", year: 1965, title: "Speaker", entry: entry("Barfield, O.", "1965", "Unancestral Voice") }),
  anon: work("anon", { key: "beowulf", short: null, names: "", year: null, title: "Beowulf", entry: entry("", "n.d.", "Beowulf") }),
  gone: work("gone", { key: "gone1999", short: null, names: "Gone", year: 1999, title: "Gone", deleted: true, entry: entry("Gone, G.", "1999", "Lost") }),
};

let pos = 0;
const cite = (...refIds: string[]): ChipOccurrence => ({ kind: CITATION, iid: `c${pos}`, pos: pos++, data: { items: refIds.map((refId) => ({ refId, locator: "4" })) } });
const styles = (form: CitationForm) => ({ [CITATION]: { form } });
const listed = (chips: ChipOccurrence[], form: CitationForm) =>
  citationBibliography(chips, styles(form), { [CITATION]: CONTEXT }).items.map((item) => [item.refId, item.lead]);

test("each work once: numbered by first citation, or alphabetical by first author", () => {
  const chips = [cite("radner"), cite("bu", "anon"), cite("radner"), cite("bu")];
  assert.deepEqual(listed(chips, "numeric"), [
    ["radner", "[1]"],
    ["bu", "[2]"],
    ["anon", "[3]"],
  ]);
  // A work with no author goes by its title.
  assert.deepEqual(listed(chips, "author-date"), [
    ["bu", null],
    ["anon", null],
    ["radner", null],
  ]);
});

test("a numeric entry's number is its label's", () => {
  const chips = [cite("anon"), cite("radner", "bu")];
  const labels = citationKind.render(
    chips.map((chip) => citationKind.validate(chip.data)!),
    { form: "numeric" },
    CONTEXT,
  );
  assert.equal(labels[1].label, "[2, p. 4; 3, p. 4]");
  assert.deepEqual(listed(chips, "numeric").map(([, lead]) => lead), ["[1]", "[2]", "[3]"]);
});

test("the short form leads with the abbreviation its labels show, told apart as they are", () => {
  assert.deepEqual(listed([cite("bu"), cite("radner")], "short"), [
    ["bu", "BU"],
    ["radner", null],
  ]);
  // Two works sharing an abbreviation gain the year, here as in the labels.
  assert.deepEqual(listed([cite("bu2"), cite("bu")], "short"), [
    ["bu", "BU 1957"],
    ["bu2", "BU 1965"],
  ]);
});

test("what is left out, and what is struck through", () => {
  const mention: ChipOccurrence = { kind: MENTION, iid: "m", pos: 99, data: { userId: "u1" } };
  const refused: ChipOccurrence = { kind: CITATION, iid: "bad", pos: 98, data: { items: [] } };
  const result = citationBibliography([cite("missing"), mention, refused, cite("gone"), cite("radner")], styles("numeric"), { [CITATION]: CONTEXT });
  // A work the context lacks shows "unknown work" in the text, and numbers nothing.
  assert.deepEqual(
    result.items.map((item) => [item.refId, item.lead, item.href, item.deleted]),
    [
      ["gone", "[1]", null, true],
      ["radner", "[2]", "/references/radner2012", false],
    ],
  );
  assert.deepEqual(citationBibliography([mention], styles("short"), {}).items, []);
});

test("as a post's text: a heading, and a paragraph per work with its title linked", () => {
  const chapter = work("ch", {
    key: "smith2001",
    short: null,
    names: "Smith",
    year: 2001,
    title: "A Chapter",
    entry: entry("Smith, J.", "2001", "A Chapter", { titleIsContainer: false, source: "In Essays" }),
  });
  const context = { [CITATION]: { ...CONTEXT, ch: chapter } };
  const content = bibliographyContent(citationBibliography([cite("ch"), cite("bu"), cite("gone")], styles("short"), context));
  assert.deepEqual(content[0], { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "References" }] });
  assert.deepEqual(content[1].content, [
    { type: "text", text: "BU ", marks: [{ type: "bold" }] },
    { type: "text", text: "Barfield, O. (1957). " },
    { type: "text", text: "Saving the Appearances", marks: [{ type: "italic" }, { type: "link", attrs: { href: "/references/barfield1957" } }] },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(
    content[2].content?.map((run) => [run.text, run.marks?.map((mark) => mark.type) ?? []]),
    [
      ["Gone, G. (1999). ", ["strike"]],
      ["Lost", ["italic", "strike"]],
      [".", ["strike"]],
    ],
  );
  // A part's title is quoted rather than italicized.
  assert.deepEqual(
    content[3].content?.map((run) => [run.text, run.marks?.map((mark) => mark.type) ?? []]),
    [
      ["Smith, J. (2001). ", []],
      ["“A Chapter.”", ["link"]],
      [" In Essays.", []],
    ],
  );
  assert.deepEqual(bibliographyContent(citationBibliography([], styles("short"), context)), []);
});
