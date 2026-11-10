import { test } from "node:test";
import assert from "node:assert/strict";
import { CSL_TYPES, citedNames, cslOf, keyBaseOf, parseCslItem, readCsl, titleOf, type CslData } from "./csl";
import { entryParts, entryText, referenceEntry } from "./entry";
import { identifiersOf } from "./identifiers";
import { foldKey, isKeyShaped, isLibraryKey, lookupKey, referencePath } from "./keys";
import { decodeCharacterReferences, markupOf, titleRuns } from "./markup";

// docs/CITATIONS.md, "What a record keeps" and "Keys" — what a record holds
// once parsed, how its markup and its names are read, and what a key may be.

const parsed = (raw: unknown): CslData => {
  const result = parseCslItem(raw);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.item;
};

test("every CSL 1.0.2 type is kept, and every variable by its schema type", () => {
  assert.equal(CSL_TYPES.length, 45);
  for (const type of CSL_TYPES) assert.equal(parsed({ type, title: "T" }).type, type);
  const item = parsed({
    type: "article-journal",
    title: "T",
    ISSN: "1234-5678",
    PMID: 12345,
    PMCID: "PMC678",
    archive: "arXiv",
    archive_location: "1706.03762",
    "number-of-pages": 320,
    translator: [{ family: "Fagles", given: "Robert" }],
    accessed: { "date-parts": [[2024, 3, 9]] },
    issued: { "date-parts": [[2012, 6, 15], [2012, 7]] },
    custom: { anything: true },
    id: "ignored",
  });
  assert.deepEqual(
    [item.ISSN, item.PMID, item.PMCID, item.archive, item.archive_location, item["number-of-pages"], item.translator, item.accessed, item.issued],
    ["1234-5678", "12345", "PMC678", "arXiv", "1706.03762", "320", [{ family: "Fagles", given: "Robert" }], { "date-parts": [[2024, 3, 9]] }, { "date-parts": [[2012, 6, 15], [2012, 7]] }],
  );
  assert.equal("custom" in item || "id" in item, false);
  // A date as text keeps its month and day.
  assert.deepEqual(parsed({ type: "book", title: "T", issued: "2012-06-15" }).issued, { "date-parts": [[2012, 6, 15]] });
  // Legacy names are read as the variable they became.
  assert.equal(parsed({ type: "article-journal", title: "T", journalAbbreviation: "J. W." })["container-title-short"], "J. W.");
});

test("a list of names past 200 is cut, and said to be", () => {
  const result = parseCslItem({ type: "article-journal", title: "T", author: Array.from({ length: 250 }, (_, i) => ({ family: `F${i}` })) });
  assert.ok(result.ok);
  assert.equal((result.item.author ?? []).length, 200);
  assert.deepEqual(result.notes, [{ kind: "cut", field: "author" }]);
});

test("a title keeps its markup in one spelling; every other field loses its tags", () => {
  const item = parsed({
    type: "article-journal",
    title: "A Commentary on <I>Hamlet</I> and <EM>Lear</EM>: <span style=\"font-variant: small-caps\">sc</span> H<sub>2</sub>O",
    "container-title": "<b>Journal</b>",
    abstract: "<jats:p>Results <jats:italic>held</jats:italic>, p &lt; 0.05.</jats:p>",
  });
  assert.equal(item.title, 'A Commentary on <i>Hamlet</i> and Lear: <span style="font-variant:small-caps;">sc</span> H<sub>2</sub>O');
  assert.equal(item["container-title"], "<b>Journal</b>");
  assert.equal(item.abstract, "Results held, p < 0.05.");
  // Read back, a title is its text and its runs.
  const read = cslOf(item)!;
  assert.equal(titleOf(read), "A Commentary on Hamlet and Lear: sc H2O");
  assert.deepEqual(read.title!.runs.slice(0, 2), [{ text: "A Commentary on " }, { text: "Hamlet", marks: ["italic"] }]);
});

test("character references are decoded before tags are read, and a < that opens no tag is text", () => {
  assert.equal(decodeCharacterReferences("AT&amp;T &#x2013; &#8212; &lt;i&gt; &bogus;"), "AT&T – — <i> &bogus;");
  assert.equal(parsed({ type: "book", title: "Crossref &lt;i&gt;meant&lt;/i&gt; it" }).title, "Crossref <i>meant</i> it");
  assert.equal(parsed({ type: "book", title: "When p < 0.05 and q>1" }).title, "When p < 0.05 and q>1");
  assert.equal(parsed({ type: "book", title: "<script>x</script> and <foo bar>y" }).title, "x and y");
  // A stored record read back isn't decoded twice: its `&amp;` is text.
  assert.equal(cslOf({ type: "book", title: "Tom &amp; Jerry" })!.title!.text, "Tom &amp; Jerry");
  // The markup round-trips: what was stored reads back as itself.
  for (const title of ['<i>a <b>b</b></i> c', 'x <span class="nocase">iPhone</span>', "p < 0.05 <sup>2</sup>"]) {
    assert.equal(markupOf(titleRuns(title)), title);
  }
});

test("a title with markup: text for a label and a key, runs for an entry, and italics inside an italic title roman", () => {
  const book = cslOf({ type: "book", title: "A Commentary on <i>Hamlet</i>", author: [{ family: "Bradley" }], issued: { "date-parts": [[1904]] } })!;
  assert.equal(keyBaseOf(book), "bradley1904");
  assert.equal(entryText(book), "Bradley (1904). A Commentary on Hamlet.");
  const [, title] = entryParts(referenceEntry(book));
  assert.deepEqual(title.runs, [{ text: "A Commentary on ", marks: ["italic"] }, { text: "Hamlet" }]);
  // A part's title is quoted, and its italics stay italics.
  const article = cslOf({ type: "article-journal", title: "On <i>Hamlet</i>", "container-title": "Mind" })!;
  const [quoted] = entryParts(referenceEntry(article));
  assert.deepEqual(quoted.runs, [{ text: "“On " }, { text: "Hamlet", marks: ["italic"] }, { text: ".”" }]);
  // A title with no markup draws as one run.
  assert.deepEqual(entryParts(referenceEntry(cslOf({ type: "article-journal", title: "Plain", "container-title": "Mind" })!))[0].runs, [{ text: "“Plain.”" }]);
  assert.equal(keyBaseOf(cslOf({ type: "book", title: "<i>Beowulf</i>" })!), "beowulf");
});

test("names keep both particles and the suffix: a non-dropping one is the family name's, everywhere", () => {
  const item = cslOf({
    type: "book",
    title: "Symphonies",
    author: [
      { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" },
      { family: "Humboldt", given: "Alexander", "dropping-particle": "von" },
      { family: "King", given: "Martin Luther", suffix: "Jr." },
    ],
    issued: { "date-parts": [[1801]] },
  })!;
  assert.deepEqual(item.author?.[0], { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" });
  assert.equal(citedNames(item), "van Beethoven et al.");
  assert.equal(keyBaseOf(item), "vanbeethoven1801");
  assert.equal(referenceEntry(item).authors, "van Beethoven, L., Humboldt, A. von and King, M. L., Jr.");
  assert.equal(citedNames(readCsl({ type: "book", title: "T", author: [{ family: "Alembert", "non-dropping-particle": "d'" }] })), "d'Alembert");
});

test("an ISBN identifies a record with no container that isn't a part by type", () => {
  const isbn = "978-0-19-973136-7";
  const isbns = (record: Record<string, unknown>) => identifiersOf({ type: "book", title: "T", ISBN: isbn, ...record }).identifiers.filter((id) => id.scheme === "ISBN").length;
  for (const type of ["book", "report", "thesis", "software", "dataset", "standard", "manuscript"]) assert.equal(isbns({ type }), 1, type);
  for (const type of ["chapter", "paper-conference", "article-journal", "article", "entry-encyclopedia", "post-weblog", "review-book"]) assert.equal(isbns({ type }), 0, type);
  assert.equal(isbns({ type: "book", "container-title": "A Whole" }), 0);
  // Two papers from one proceedings, each with its ISBN and no booktitle, aren't one work.
  const paper = (title: string) => identifiersOf({ type: "paper-conference", title, ISBN: isbn }).identifiers;
  assert.deepEqual([paper("One"), paper("Two")], [[], []]);
  // An ISBN is found by its shape, a note beside it or another one after one space.
  assert.deepEqual(
    identifiersOf({ type: "book", ISBN: "9780631175049 (pbk.)" }).identifiers.map((id) => id.value),
    ["9780631175049"],
  );
  assert.deepEqual(
    identifiersOf({ type: "book", ISBN: "0631175040 0199731365" }).identifiers.map((id) => id.value),
    ["9780631175049", "9780199731367"],
  );
});

test("a library key is as given when it fits; a lookup folds A to Z and nothing else", () => {
  for (const key of ["radner2012", "Frank_1970", "radnerOriginIdeas2012", "smith.jones-2012", "a:b", "_x", "x".repeat(80)]) assert.equal(isLibraryKey(key), true, key);
  for (const key of ["", "a..b", "-a", "a-", "DBLP:conf/nips/X", "Müller2012", "a b", "x".repeat(81)]) assert.equal(isLibraryKey(key), false, key);
  assert.equal(foldKey("Frank_1970"), "frank_1970");
  // An alias's other letters keep their case, composed once.
  assert.equal(foldKey("ÄrgerMüller"), "Ärgermüller");
  assert.equal(lookupKey("Ärger"), "Ärger");
  assert.equal(isKeyShaped("DBLP:conf/nips/VaswaniSPHGTS17"), true);
  assert.equal(isKeyShaped("a b"), false);
  assert.equal(referencePath("a:b"), "/references/a%3Ab");
});
