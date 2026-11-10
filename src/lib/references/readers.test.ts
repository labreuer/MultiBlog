import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cutBatches } from "./batches";
import { detectFormat, parseReferences, readAs, type ImportedReference } from "./import";

// docs/CITATIONS.md, "The readers" — each source's export read into the CSL
// it must yield, with each reader's mended cases. The fixtures are real
// public records, trimmed, and hand-made cases (fixtures/).

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

async function read(name: string): Promise<ImportedReference[]> {
  const result = await parseReferences(fixture(name));
  assert.deepEqual(result.errors, [], name);
  return result.references;
}

const pick = (reference: ImportedReference, ...fields: string[]) => Object.fromEntries(fields.map((field) => [field, reference.data[field]]));

test("BibTeX from Zotero: every TeX accent, BibTeX's name grammar, a translator, keys as written", async () => {
  const [book, chapter] = await read("zotero.bib");
  assert.equal(book.sourceKey, "radner_origin_2012");
  assert.deepEqual(book.data.author, [
    { family: "Radner", given: "Daisie" },
    { family: "Fraassen", given: "Bas C.", "non-dropping-particle": "van" },
    { family: "King", given: "Martin Luther", suffix: "Jr." },
  ]);
  assert.deepEqual(book.data.translator, [{ family: "Anscombe", given: "G. E. M." }]);
  // A URL is kept verbatim: its `~` isn't a space.
  assert.equal(book.data.URL, "https://example.org/~radner/book.pdf");
  // The braces that protect capitals leave nothing behind, and the case is as written.
  assert.equal(book.data.title, "The Origin of Ideas: a study");
  assert.equal(chapter.data.title, "On Graphs of Erdős and Łukasiewicz and al-Fārābı̄");
  assert.deepEqual(pick(chapter, "type", "container-title", "page", "publisher"), { type: "chapter", "container-title": "A Festschrift", page: "49–51", publisher: "Akadémiai Kiadó" });
  assert.deepEqual(chapter.data.author?.map((name) => name.family), ["Erdős", "Łukasiewicz", "Dvořák"]);
});

test("biblatex from Better BibTeX: software, a dataset, a whole date, and shorthand as the abbreviation", async () => {
  const records = await read("bbt.biblatex");
  assert.deepEqual(records.map((r) => [r.sourceKey, r.data.type]), [
    ["radnerOriginIdeas2012", "book"],
    ["smithDissertation2001", "thesis"],
    ["doeBlogPost2020", "webpage"],
    ["doeTool2021", "software"],
    ["doeData2021", "dataset"],
  ]);
  assert.equal(records[0].short, "OI");
  assert.deepEqual(records[2].data.issued, { "date-parts": [[2020, 5, 3]] });
});

test("arXiv and INSPIRE: an eprint in arXiv's form is an archive and its location", async () => {
  const [arxiv] = await read("arxiv.bib");
  assert.deepEqual(pick(arxiv, "archive", "archive_location"), { archive: "arXiv", archive_location: "1706.03762" });
  const [inspire] = await read("inspire.bib");
  assert.deepEqual(pick(inspire, "archive", "archive_location", "DOI"), { archive: "arXiv", archive_location: "1207.7214", DOI: "10.1016/j.physletb.2012.08.020" });
  // biblatex's own form, `eprinttype`, reads the same.
  const { references } = await readAs("bibtex", "@online{b2, title={Two}, author={B, A}, eprint={2101.00001}, eprinttype={arxiv}, date={2021-01-03}}");
  assert.deepEqual(pick(references[0], "archive", "archive_location"), { archive: "arXiv", archive_location: "2101.00001" });
});

test("ADS: a journal macro names its journal, and a bare word no @string defines is dropped and said to be", async () => {
  const [ads, macro] = await read("ads.bib");
  assert.equal(ads.data["container-title"], "Physical Review Letters");
  // A braced name is one family name, its particle inside it.
  assert.deepEqual(ads.data.author?.map((name) => name.family), ["Abbott", "Abbott", "van der Klis"]);
  assert.equal(macro.data["container-title"], undefined);
  assert.deepEqual(macro.notes, [{ kind: "undefined", field: "journal" }]);
});

test("dblp: crossref inheritance across the file, a key with / kept as written, and each paper's ISBN its proceedings'", async () => {
  const [paper, child, proceedings] = await read("dblp-crossref.bib");
  assert.equal(paper.sourceKey, "DBLP:conf/nips/VaswaniSPHGTS17");
  assert.deepEqual(pick(child, "type", "container-title", "ISBN"), { type: "paper-conference", "container-title": "Proceedings of X 2018", ISBN: "978-3-16-148410-0" });
  assert.equal(proceedings.data.type, "book");
});

test("BibTeX's mended cases: and others, a month joined to a day, \\emph as italics, an unparseable entry reported alone", async () => {
  const { references } = await readAs(
    "bibtex",
    `@article{m, title = {On \\emph{Hamlet}}, author = {A, B and others}, journal = {J}, month = jun # "~15", year = 1970}`,
  );
  assert.deepEqual(references[0].data.author, [{ family: "A", given: "B" }]);
  assert.deepEqual(references[0].data.issued, { "date-parts": [[1970, 6, 15]] });
  assert.equal(references[0].data.title, "On <i>Hamlet</i>");
  const broken = await readAs("bibtex", "@book{ok1, title={Fine}, year=2000}\n@incollection{broken,\n title = {Never closed\n@article{ok2, title={Also fine}}\n");
  assert.deepEqual(broken.references.map((r) => r.sourceKey), ["ok1", "ok2"]);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], /@incollection entry/);
});

test("markup: a title's italics and symbols, an @string, and shorthand", async () => {
  const [markup, macro] = await read("markup.bib");
  assert.equal(markup.data.title, "The DNA of <i>E. coli</i> and <i>Homo sapiens</i>: H₂O at 5% & more");
  assert.deepEqual(markup.data.author?.slice(1, 3), [
    { family: "Fontaine", given: "Jean", "non-dropping-particle": "de la" },
    { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" },
  ]);
  assert.deepEqual([macro.data["container-title"], macro.short], ["Proc. Natl. Acad. Sci.", "QT"]);
});

test("an ISBN found by its shape, and one that fails its check dropped with the record kept", async () => {
  const [two, pbk, bad] = await read("isbn.bib");
  assert.equal(two.data.ISBN, "0631175040 0631175059");
  assert.equal(pbk.notes.length, 0);
  assert.equal(bad.data.ISBN, undefined);
  assert.deepEqual(bad.notes, [{ kind: "identifier", scheme: "ISBN", raw: "9780631175040" }]);
});

test("RIS: Crossref's two SN lines as one ISSN, a whole date, and a report's SN as its number", async () => {
  const [crossref] = await read("crossref.ris");
  assert.deepEqual(pick(crossref, "ISSN", "page", "issued", "DOI"), { ISSN: "0036-8075, 1095-9203", page: "635–641", issued: { "date-parts": [[1970, 8, 14]] }, DOI: "10.1126/science.169.3946.635" });
  const [report, article, legal, dataset] = await read("report.ris");
  assert.deepEqual(pick(report, "type", "number", "ISBN"), { type: "report", number: "NASA-TM-1999-209834", ISBN: undefined });
  assert.deepEqual(pick(article, "type", "ISSN", "ISBN"), { type: "article-journal", ISSN: "0028-0836", ISBN: undefined });
  assert.deepEqual([legal.data.type, dataset.data.type], ["legal_case", "dataset"]);
  const { references } = await readAs("ris", "TY  - JOUR\nID  - Smith_Rep:1\nTI  - T\nER  - \n");
  assert.equal(references[0].sourceKey, "Smith_Rep:1");
});

test("CSL-JSON: Zotero's names, types and fields; a key from citation-key or an id that isn't a URL", async () => {
  const records = await read("zotero-csl.json");
  assert.deepEqual(records.map((r) => [r.sourceKey, r.data.type]), [
    [null, "book"],
    ["smithData2021", "dataset"],
    ["brown1954", "legal_case"],
    ["p1", "post-weblog"],
    ["s1", "software"],
    ["m1", "manuscript"],
  ]);
  assert.deepEqual(records[0].data.author?.[2], { family: "Humboldt", given: "Alexander", "dropping-particle": "von" });
  assert.deepEqual(pick(records[0], "call-number", "ISSN", "number-of-pages"), { "call-number": "ML410", ISSN: "1234-5678", "number-of-pages": "320" });
  const many = await parseReferences(JSON.stringify([{ id: "Barfield1957", type: "book", title: "Saving the Appearances" }, { type: "book" }]));
  assert.deepEqual(many.references.map((r) => [r.sourceKey, r.data]), [["Barfield1957", { type: "book", title: "Saving the Appearances" }]]);
  assert.deepEqual(many.errors, ["Item 2: A reference needs a title."]);
});

test("Crossref's CSL-JSON: its type named as CSL's, its lists as one value, its JATS abstract as text, not refused for its size", async () => {
  const [work] = await read("crossref.json");
  assert.equal(work.data.type, "article-journal");
  assert.equal(work.data.ISSN, "0036-8075, 1095-9203");
  assert.equal(String(work.data.abstract).includes("<jats"), false);
  assert.ok(work.notes.some((note) => note.kind === "dropped" && note.field === "reference"));
  assert.ok(work.notes.some((note) => note.kind === "mapped" && note.from === "journal-article"));
});

test("PubMed's .nbib: full names, the DOI from AID, a whole date, PMID, PMCID and ISSNs", async () => {
  const [record] = await read("pubmed.nbib");
  assert.deepEqual(pick(record, "type", "title", "container-title", "volume", "issue", "page", "DOI", "PMID", "PMCID", "ISSN", "issued"), {
    type: "article-journal",
    title: "Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine",
    "container-title": "The New England journal of medicine",
    volume: "383",
    issue: "27",
    page: "2603–2615",
    DOI: "10.1056/NEJMoa2034577",
    PMID: "33301246",
    PMCID: "PMC7745181",
    ISSN: "1533-4406, 0028-4793",
    issued: { "date-parts": [[2020, 12, 31]] },
  });
  assert.deepEqual(record.data.author?.[0], { family: "Polack", given: "Fernando P" });
  // A paper online ahead of print keeps its DOI in LID.
  const [ahead] = (await readAs("nbib", "PMID- 1\nTI  - Ahead.\nLID - 10.1000/ahead [doi]\nAU  - Smith JA\nDP  - 2024 Mar\n")).references;
  assert.deepEqual(pick(ahead, "DOI", "issued", "author"), { DOI: "10.1000/ahead", issued: { "date-parts": [[2024, 3]] }, author: [{ family: "Smith", given: "J. A." }] });
});

test("a CITATION.cff: only the file's own work, as software, never the works its references list cites", async () => {
  const records = await read("CITATION.cff");
  assert.equal(records.length, 1);
  assert.deepEqual(pick(records[0], "type", "title", "version"), { type: "software", title: "Citation File Format", version: "1.2.0" });
});

test("formats a source also exports one we read in place of are refused, naming the export to use", () => {
  const refusal = (name: string) => {
    const detected = detectFormat(fixture(name));
    assert.ok(detected && "refused" in detected, name);
    return detected.refused;
  };
  assert.match(refusal("endnote.xml"), /EndNote XML.*RIS/);
  assert.match(refusal("x.enw"), /\.enw.*RIS/);
  assert.match(refusal("wos.ciw"), /Web of Science.*RIS/);
  assert.match(refusal("scopus.csv"), /Scopus.*RIS or BibTeX/);
  assert.match(refusal("refs.yaml"), /CSL-YAML/);
  assert.match(refusal("refworks.rtf.txt"), /RefWorks/);
  assert.deepEqual(detectFormat("<mods:mods xmlns:mods=\"http://www.loc.gov/mods/v3\">"), { refused: "That is MODS. Export as BibTeX, RIS or CSL-JSON instead." });
  assert.ok("refused" in detectFormat("Just some prose about a book.")!);
  assert.equal(detectFormat("   "), null);
});

test("a URL or a DOI handed to each reader by name reads nothing", async () => {
  for (const format of ["bibtex", "ris", "cff", "nbib"] as const) {
    for (const text of ["https://doi.org/10.1000/xyz", "10.1000/xyz"]) {
      assert.equal((await readAs(format, text)).references.length, 0, `${format} ${text}`);
    }
  }
});

test("batches are cut by records and by bytes as UTF-8, with records in a script of three bytes to the character", () => {
  const small = Array.from({ length: 250 }, (_, i) => ({ place: i }));
  assert.deepEqual(cutBatches(small).map((batch) => batch.length), [100, 100, 50]);
  // Twenty thousand characters of three bytes each: 60,000 bytes a record, so eight fit in 500,000.
  const wide = Array.from({ length: 20 }, (_, i) => ({ place: i, title: "あ".repeat(20_000) }));
  const batches = cutBatches(wide);
  assert.deepEqual(batches.map((batch) => batch.length), [8, 8, 4]);
  for (const batch of batches) assert.ok(new TextEncoder().encode(JSON.stringify(batch)).length <= 500_000);
  assert.deepEqual(batches.flat(), wide);
});
