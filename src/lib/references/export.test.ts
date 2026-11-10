import { test } from "node:test";
import assert from "node:assert/strict";
import type { CslData } from "./csl";
import { rejoinLines, writeReferences, type ExportFormat, type ExportRecord } from "./export";
import { readAs } from "./import";

// docs/CITATIONS.md, "Downloads" — each writer between its two passes, read
// back by the readers the import box uses, so a download round-trips into
// MultiBlog itself as it does into the tools that read it.

const article: ExportRecord = {
  key: "Frank_1970:x.y-z",
  data: {
    type: "article-journal",
    title: "The <i>DNA</i> of Erdős & H₂O: 50% more, 日本語の題",
    author: [
      { family: "King", given: "Martin Luther", suffix: "Jr." },
      { family: "Достоевский", given: "Фёдор" },
    ],
    issued: { "date-parts": [[1970, 8, 14]] },
    "container-title": "Science",
    volume: "169",
    issue: "3946",
    page: "635–641",
    DOI: "10.1126/science.169.3946.635",
    archive: "arXiv",
    archive_location: "1706.03762",
  },
};

const chapter: ExportRecord = {
  key: "lukasiewicz1990",
  data: {
    type: "chapter",
    title: "A Chapter",
    author: [{ family: "Łukasiewicz", given: "Jan" }],
    editor: [{ family: "Schönberg", given: "Arnold" }],
    "container-title": "A Festschrift",
    publisher: "Akadémiai Kiadó",
    page: "49–51",
    issued: { "date-parts": [[1990, 6, 15]] },
  },
};

const particles: ExportRecord = {
  key: "particles",
  data: {
    type: "book",
    title: "Particles",
    author: [
      { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" },
      { family: "Humboldt", given: "Alexander", "dropping-particle": "von" },
    ],
  },
};

async function roundTrip(record: ExportRecord, format: Exclude<ExportFormat, "csl-json">): Promise<{ key: string | null; data: CslData }> {
  const written = writeReferences([record], format);
  const read = await readAs(format === "ris" ? "ris" : "bibtex", written);
  assert.deepEqual(read.errors, [], written);
  assert.equal(read.references.length, 1, written);
  return { key: read.references[0].sourceKey, data: read.references[0].data };
}

test("CSL-JSON is the stored record, its id and citation-key the key", () => {
  const [written] = JSON.parse(writeReferences([article], "csl-json"));
  assert.deepEqual(written, { id: article.key, "citation-key": article.key, ...article.data });
});

test("each format round-trips the fields it holds: a suffix, italics, & and %, Cyrillic, Japanese, a page range, a key with : . and -", async () => {
  for (const format of ["bibtex", "biblatex", "ris"] as const) {
    const { key, data } = await roundTrip(article, format);
    assert.equal(key, article.key, format);
    assert.deepEqual(data.author, article.data.author, format);
    assert.equal(data.page, "635–641", format);
    assert.equal(data.DOI, article.data.DOI, format);
    assert.equal(data["container-title"], "Science", format);
    // RIS has no tag for markup, and BibTeX writes H₂O as H2O, which every BibTeX reads.
    const title = { bibtex: "The <i>DNA</i> of Erdős & H2O: 50% more, 日本語の題", biblatex: article.data.title, ris: "The DNA of Erdős & H₂O: 50% more, 日本語の題" }[format];
    assert.equal(data.title, title, format);
    // RIS has no tag for an arXiv id; the two BibTeX forms write it as an eprint.
    assert.deepEqual([data.archive, data.archive_location], format === "ris" ? [undefined, undefined] : ["arXiv", "1706.03762"], format);
  }
});

test("a title's & and % are escaped for LaTeX, and a character with no TeX stays UTF-8 rather than vanishing", () => {
  const bib = writeReferences([article], "bibtex");
  assert.match(bib, /\\& \{H2O\}: 50\\% more, 日本語の題/);
  assert.match(bib, /Достоевский, Фёдор/);
  const biblatex = writeReferences([article], "biblatex");
  assert.match(biblatex, /\{Erdős\} \\& \{H₂O\}: 50\\% more/);
  assert.match(biblatex, /pages = \{635--641\}/);
});

test("both particles: non-dropping from BibTeX and biblatex, and from RIS one in the family name and one after the given name", async () => {
  for (const format of ["bibtex", "biblatex"] as const) {
    assert.deepEqual((await roundTrip(particles, format)).data.author, [
      { family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" },
      { family: "Humboldt", given: "Alexander", "non-dropping-particle": "von" },
    ]);
  }
  const ris = writeReferences([particles], "ris");
  assert.match(ris, /^AU {2}- van Beethoven, Ludwig$/m);
  assert.match(ris, /^AU {2}- Humboldt, Alexander von$/m);
});

test("BibTeX: a date with a day as the month's macro and a day field, and a chapter as @incollection", async () => {
  const bib = writeReferences([chapter, article], "bibtex");
  assert.match(bib, /^@incollection\{lukasiewicz1990,$/m);
  assert.match(bib, /^\tmonth = jun,\n\tday = \{15\},$/m);
  assert.match(bib, /^\tmonth = aug,\n\tday = \{14\},$/m);
  assert.deepEqual((await roundTrip(chapter, "bibtex")).data.issued, { "date-parts": [[1990, 6, 15]] });
  // biblatex keeps @inbook, which has a booktitle there, and a whole date.
  assert.match(writeReferences([chapter], "biblatex"), /^@inbook\{lukasiewicz1990,$/m);
  assert.match(writeReferences([chapter], "biblatex"), /^\tdate = \{1990-06-15\},$/m);
  // A month with no day is the macro alone.
  assert.match(writeReferences([{ key: "m", data: { type: "book", title: "T", issued: { "date-parts": [[2001, 3]] } } }], "bibtex"), /^\tmonth = mar,$/m);
});

test("biblatex keeps a PubMed id the writer puts in eprint, rather than an arXiv id beside it", () => {
  const both = writeReferences([{ key: "p", data: { ...article.data, PMID: "123" } }], "biblatex");
  assert.match(both, /^\teprint = \{123\},\n\teprinttype = \{pubmed\},$/m);
  assert.doesNotMatch(both, /eprinttype = \{arxiv\}/);
});

test("RIS: a page range as SP and EP, and every value one line, at 70, 71 and 140 characters and with a piece that reads as a tag", () => {
  assert.match(writeReferences([chapter], "ris"), /^SP {2}- 49\nEP {2}- 51$/m);
  for (const length of [69, 70, 71, 140, 141]) {
    const title = "x".repeat(length);
    const ris = writeReferences([{ key: "w", data: { type: "book", title, abstract: `${"y".repeat(70)}AU  - not a tag` } }], "ris");
    assert.ok(ris.split("\n").includes(`TI  - ${title}`), `${length}: ${ris}`);
    assert.ok(ris.split("\n").includes(`AB  - ${"y".repeat(70)}AU  - not a tag`), ris);
    assert.equal(ris.trimEnd().split("\n").filter((line) => line === "").length, 0, ris);
  }
  // A surrogate pair the writer broke between its halves is whole again.
  const emoji = `${"x".repeat(69)}😀z`;
  assert.ok(writeReferences([{ key: "e", data: { type: "book", title: emoji } }], "ris").includes(`TI  - ${emoji}`));
  assert.equal(rejoinLines(`TI  - ${"a".repeat(70)}\nb\nER  - `), `TI  - ${"a".repeat(70)}b\nER  - `);
});
