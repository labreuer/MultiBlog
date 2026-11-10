import { test } from "node:test";
import assert from "node:assert/strict";
import { citedNames, keyBaseOf, parseCslItem, readCsl, yearOf, type CslData } from "./csl";
import { entryText, referenceEntry } from "./entry";
import { identifiersOf, normalizeDoi, normalizeIsbn } from "./identifiers";
import { parseReferences } from "./import";

/** A record as a reader of one is handed it. */
const read = (data: CslData) => readCsl(data);

// docs/CITATIONS.md, "Records" and "Duplicates are caught by DOI and ISBN" —
// the reference library's pure half: what an identifier is stored as, what a
// record must be, and what each import format reads to.

test("a DOI loses its resolver prefix and its case, and anything else is refused", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1093/ACPROF:oso/9780199731367.001.0001"), "10.1093/acprof:oso/9780199731367.001.0001");
  assert.equal(normalizeDoi("http://dx.doi.org/10.1000/xyz123"), "10.1000/xyz123");
  assert.equal(normalizeDoi("doi: 10.1000/XYZ123"), "10.1000/xyz123");
  assert.equal(normalizeDoi(" 10.1000/xyz123 "), "10.1000/xyz123");
  for (const bad of ["", "xyz", "10.12/short", "https://example.com/10.1000/x", "10.1000/"]) assert.equal(normalizeDoi(bad), null, bad);
});

test("an ISBN is stored as ISBN-13, check digit verified, so the same book in either form is one value", () => {
  assert.equal(normalizeIsbn("0-631-17504-0"), "9780631175049");
  assert.equal(normalizeIsbn("978-0-631-17504-9"), "9780631175049");
  assert.equal(normalizeIsbn("ISBN 0 8044 2957 X"), "9780804429573");
  assert.equal(normalizeIsbn("isbn-13: 9780199731367"), "9780199731367");
  // A wrong check digit, a wrong length, and letters: refused, never stored.
  for (const bad of ["0-631-17504-1", "978-0-631-17504-8", "12345", "97806311750490", "abcdefghij"]) assert.equal(normalizeIsbn(bad), null, bad);
});

test("every ISBN on a book counts, a chapter is matched by its DOI alone, and a failed check is reported", () => {
  const book = { type: "book", title: "T", ISBN: "0-631-17504-0, 978-0-19-973136-7", DOI: "10.1000/Book" };
  assert.deepEqual(identifiersOf(book).identifiers, [
    { scheme: "DOI", value: "10.1000/book" },
    { scheme: "ISBN", value: "9780631175049" },
    { scheme: "ISBN", value: "9780199731367" },
  ]);
  // A second chapter of the same anthology carries the same ISBN, and is not a duplicate of the first.
  assert.deepEqual(identifiersOf({ type: "chapter", title: "T", ISBN: "0-631-17504-0", DOI: "10.1000/ch2" }).identifiers, [{ scheme: "DOI", value: "10.1000/ch2" }]);
  // The same ISBN twice, in two forms, is one identifier.
  assert.equal(identifiersOf({ type: "book", title: "T", ISBN: "0-631-17504-0; 9780631175049" }).identifiers.length, 1);
  const bad = identifiersOf({ type: "book", title: "T", ISBN: "0-631-17504-1", DOI: "nope" });
  assert.deepEqual(bad.identifiers, []);
  assert.deepEqual(bad.invalid, [
    { scheme: "DOI", raw: "nope" },
    { scheme: "ISBN", raw: "0-631-17504-1" },
  ]);
});

test("a record is built field by field: known fields, bounded, with a title", () => {
  const parsed = parseCslItem({
    type: "book",
    title: "  Saving   the Appearances ",
    author: [{ family: "Barfield", given: "Owen" }, { literal: "The Inklings" }, "not a name", { given: "Solo" }],
    issued: { "date-parts": [[1957, 3]] },
    page: "49--51",
    publisher: "Faber",
    user: { update: { role: "ADMIN" } },
    __proto__: { x: 1 },
  });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && parsed.item, {
    type: "book",
    title: "Saving the Appearances",
    publisher: "Faber",
    page: "49–51",
    author: [{ family: "Barfield", given: "Owen" }, { literal: "The Inklings" }, { literal: "Solo" }],
    issued: { "date-parts": [[1957, 3]] },
  });
  assert.deepEqual(parsed.ok && parsed.notes, [{ kind: "dropped", field: "user" }]);
  // A type CSL doesn't list is a plain document, and the parse says so; a year can arrive as text.
  const loose = parseCslItem({ type: "hologram", title: "T", issued: "c. 1957" });
  assert.deepEqual(loose.ok && [loose.item.type, yearOf(loose.item), loose.notes], ["document", 1957, [{ kind: "mapped", field: "type", from: "hologram", to: "document" }]]);
  assert.equal(parseCslItem({ type: "book" }).ok, false);
  assert.equal(parseCslItem("a string").ok, false);
  // A field past its bound is cut, and said to be; the record's size is measured once its fields are chosen.
  const long = parseCslItem({ type: "book", title: "T", abstract: "x".repeat(30_000) });
  assert.deepEqual(long.ok && [long.item.abstract?.toString().length, long.notes], [4000, [{ kind: "cut", field: "abstract" }]]);
  assert.equal(parseCslItem({ type: "book", title: "T", reference: Array.from({ length: 500 }, (_, i) => ({ key: `ref${i}`, DOI: `10.1000/${i}` })) }).ok, true);
  const fields = Object.fromEntries(["abstract", "note", "annote", "archive", "source", "genre"].map((field) => [field, "y".repeat(4000)]));
  assert.equal(parseCslItem({ type: "book", title: "T", ...fields }).ok, false);
});

test("a key is made from the first creator and the year", () => {
  const radner = read({ type: "book", title: "The Origin of Ideas", author: [{ family: "Radner", given: "Daisie" }], issued: { "date-parts": [[2012]] } });
  assert.equal(keyBaseOf(radner), "radner2012");
  assert.equal(keyBaseOf(read({ type: "book", title: "Beowulf: A New Translation" })), "beowulf");
  assert.equal(keyBaseOf(read({ type: "book", title: "T", editor: [{ family: "de la Mare" }] })), "delamare");
  assert.equal(keyBaseOf(read({ type: "book", title: "T", author: [{ family: "Müller" }], issued: { "date-parts": [[1901]] } })), "muller1901");
  assert.equal(citedNames(radner), "Radner");
  assert.equal(citedNames({ ...radner, author: [{ family: "A" }, { family: "B" }] }), "A and B");
  assert.equal(citedNames({ ...radner, author: [{ family: "A" }, { family: "B" }, { family: "C" }] }), "A et al.");
});

test("BibTeX: entries, braces, accents, names and page ranges", () => {
  const result = parseReferences(`
    % a comment line
    @string{oup = "Oxford University Press"}
    @book{Radner2012,
      author    = {Radner, Daisie and Michael J. Radner and {The Research Group}},
      title     = {The {O}rigin of Ideas: Caf\\'e Talk},
      publisher = "Clarendon " # "Press",
      year      = 2012,
      isbn      = {978-0-19-973136-7},
    }
    @article{garcia_marquez,
      author = "Gabriel Garc{\\'i}a M{\\'a}rquez and Jan van der Berg",
      title = {On Rivers},
      journal = {Journal of Water},
      volume = {12}, number = {3}, pages = {49--51},
      year = {1999}, doi = {10.1000/ABC}
    }
    @incollection{broken,
      title = {Never closed
  `);
  assert.equal(result.format, "bibtex");
  assert.deepEqual(result.references.map((r) => r.key), ["Radner2012", "garcia_marquez"]);
  const [book, article] = result.references.map((r) => r.data);
  assert.deepEqual(book, {
    type: "book",
    title: "The Origin of Ideas: Café Talk",
    publisher: "Clarendon Press",
    ISBN: "978-0-19-973136-7",
    author: [{ family: "Radner", given: "Daisie" }, { family: "Radner", given: "Michael J." }, { literal: "The Research Group" }],
    issued: { "date-parts": [[2012]] },
  });
  // Written "Given Family", the last word is the family name, as BibTeX reads
  // it, unless a lowercase particle says where it starts; "Family, Given" is
  // how a two-word family name is given.
  assert.deepEqual(article.author, [
    { family: "Márquez", given: "Gabriel García" },
    { family: "van der Berg", given: "Jan" },
  ]);
  assert.deepEqual([article.type, article["container-title"], article.volume, article.issue, article.page, article.DOI], [
    "article-journal",
    "Journal of Water",
    "12",
    "3",
    "49–51",
    "10.1000/ABC",
  ]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /@incollection entry/);
});

test("RIS: one record per TY…ER, with repeated authors and a page range", () => {
  const result = parseReferences(
    ["TY  - JOUR", "AU  - Radner, Daisie", "AU  - Barfield, Owen", "TI  - On Participation", "JO  - Mind", "PY  - 1957/03//", "SP  - 49", "EP  - 51", "DO  - 10.1000/xyz", "ER  - ", "", "TY  - CHAP", "A1  - Lewis, C. S.", "T1  - A Chapter", "T2  - The Book", "SN  - 0-631-17504-0", "ER  - "].join("\n"),
  );
  assert.equal(result.format, "ris");
  assert.equal(result.references.length, 2);
  const [article, chapter] = result.references.map((r) => r.data);
  assert.deepEqual(article, {
    type: "article-journal",
    title: "On Participation",
    "container-title": "Mind",
    page: "49–51",
    DOI: "10.1000/xyz",
    author: [{ family: "Radner", given: "Daisie" }, { family: "Barfield", given: "Owen" }],
    issued: { "date-parts": [[1957]] },
  });
  // A chapter's ISBN is its book's, and isn't kept as the chapter's own.
  assert.deepEqual(chapter, { type: "chapter", title: "A Chapter", "container-title": "The Book", author: [{ family: "Lewis", given: "C. S." }] });
});

test("CSL-JSON: one item or many, each with its id as the key, and an item with no title reported", () => {
  const many = parseReferences(JSON.stringify([{ id: "Barfield1957", type: "book", title: "Saving the Appearances" }, { type: "book" }]));
  assert.equal(many.format, "csl-json");
  assert.deepEqual(
    many.references.map((r) => [r.key, r.data]),
    [["Barfield1957", { type: "book", title: "Saving the Appearances" }]],
  );
  assert.deepEqual(many.errors, ["Item 2: A reference needs a title."]);
  assert.equal(parseReferences('{"type":"book","title":"One"}').references.length, 1);
  assert.equal(parseReferences("{not json").errors.length, 1);
  assert.deepEqual(parseReferences("Just some prose about a book."), { format: null, references: [], errors: ["That isn't BibTeX, RIS or CSL-JSON."] });
  assert.deepEqual(parseReferences("   "), { format: null, references: [], errors: [] });
});

test("a bibliography entry: authors, year, title, then where it appeared", () => {
  assert.equal(
    entryText(read({
      type: "book",
      title: "Saving the Appearances",
      author: [{ family: "Barfield", given: "Owen" }],
      issued: { "date-parts": [[1957]] },
      publisher: "Faber",
      "publisher-place": "London",
    })),
    "Barfield, O. (1957). Saving the Appearances. London: Faber.",
  );
  // An article: its title quoted, the journal with volume, issue and pages.
  assert.equal(
    entryText(read({
      type: "article-journal",
      title: "On Rivers",
      author: [{ family: "García Márquez", given: "Gabriel José" }, { family: "Berg", given: "Jan" }, { literal: "The Water Group" }],
      issued: { "date-parts": [[1999]] },
      "container-title": "Journal of Water",
      volume: "12",
      issue: "3",
      page: "49–51",
    })),
    "García Márquez, G. J., Berg, J. and The Water Group (1999). “On Rivers.” Journal of Water 12(3), pp. 49–51.",
  );
  // A chapter names its book and the book's editors; one page is "p.".
  assert.equal(
    entryText(read({
      type: "chapter",
      title: "Is It True?",
      author: [{ family: "Lewis", given: "C. S." }],
      editor: [{ family: "Hooper", given: "Walter" }],
      "container-title": "Essays",
      page: "7",
      publisher: "Collins",
    })),
    "Lewis, C. S. (n.d.). “Is It True?” In Essays, ed. Hooper, W., p. 7. Collins.",
  );
  // An edited volume is listed under its editors; a work with nobody is listed by its title.
  assert.equal(entryText(read({ type: "collection", title: "Essays", editor: [{ family: "Hooper" }, { family: "Green" }], issued: { "date-parts": [[1966]] } })), "Hooper and Green (eds.) (1966). Essays.");
  assert.equal(entryText(read({ type: "book", title: "Beowulf" })), "Beowulf. (n.d.).");
  // A title is quoted when its record has a container, whatever its type, and in italics otherwise.
  assert.equal(referenceEntry(read({ type: "book", title: "Beowulf" })).titleIsContainer, true);
  assert.equal(referenceEntry(read({ type: "chapter", title: "A Part", "container-title": "A Whole" })).titleIsContainer, false);
  assert.equal(referenceEntry(read({ type: "chapter", title: "A Part" })).titleIsContainer, true);
  assert.equal(entryText(read({ type: "post-weblog", title: "A Post", "container-title": "A Blog", issued: { "date-parts": [[2020]] } })), "“A Post.” (2020). A Blog.");
});
