import { plugins } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import "@citation-js/plugin-ris";
import type { CslData, CslName } from "./csl";
import type { ExportFormat } from "./export-formats";
import { markedText } from "./markup";

// docs/CITATIONS.md, "Downloads" — works written in the four formats the
// tools people keep a library in read, from a list of records, so every place
// a download is offered agrees: CSL-JSON, BibTeX, biblatex and RIS.
//
// **Server-only**: citation-js's core and its BibTeX and RIS plugins are
// server dependencies for these writers, and no reader is called here
// (the readers run in the browser, import.ts).
//
// Each writer runs between two passes of ours, which mend what it loses or
// writes wrongly; each pass is named in the plan with what it measured.

export { EXPORT_FORMATS, EXPORT_FORMAT_ORDER, isExportFormat, type ExportFormat } from "./export-formats";

/** One work to write: the library's key, and the stored record. */
export type ExportRecord = { key: string; data: CslData };

type Constants = {
  commands: Record<string, string>;
  diacritics: Record<string, string>;
  ligatures: Record<string, string>;
  mathCommands: Record<string, string>;
};
const bibtexConfig = plugins.config.get("@bibtex") as unknown as {
  format: { useIdAsLabel: boolean; checkLabel: boolean; asciiOnly: boolean };
  constants: Constants;
};
// An entry's key is the library's, as given: `checkLabel` would take the `:`, `.` and `-` out of one.
bibtexConfig.format.useIdAsLabel = true;
bibtexConfig.format.checkLabel = false;
// TeX for every character the writer has TeX for, since every BibTeX reads that.
bibtexConfig.format.asciiOnly = true;

/** Writes `records`, in the order given, as `format`. */
export function writeReferences(records: readonly ExportRecord[], format: ExportFormat): string {
  switch (format) {
    case "csl-json":
      return `${JSON.stringify(records.map(cslJsonOf), null, 2)}\n`;
    case "bibtex":
      return records.map((record) => writeBib(record, "bibtex")).join("\n");
    case "biblatex":
      return records.map((record) => writeBib(record, "biblatex")).join("\n");
    case "ris":
      return records.map(writeRis).join("\n");
  }
}

/** The stored record, with `id` and `citation-key` set to the key: nothing the library holds is left out. */
function cslJsonOf(record: ExportRecord): Record<string, unknown> {
  return { id: record.key, "citation-key": record.key, ...withoutKeyFields(record.data) };
}

function withoutKeyFields(data: CslData): CslData {
  const { id: _id, "citation-key": _key, ...rest } = data as CslData & { id?: unknown; "citation-key"?: unknown };
  void _id;
  void _key;
  return rest as CslData;
}

const NAME_FIELDS = ["author", "editor", "translator", "collection-editor", "container-author", "contributor", "compiler", "director", "illustrator", "interviewer", "recipient", "reviewed-author", "original-author"];

/** A copy of a record with each name passed through `change`. */
function withNames(data: CslData, change: (name: CslName) => CslName): CslData {
  const out: CslData = { ...data };
  for (const field of NAME_FIELDS) {
    const names = data[field];
    if (Array.isArray(names)) out[field] = (names as CslName[]).map(change);
  }
  return out;
}

/** citation-js's writer over one record, as one entry's text. */
function format(style: "bibtex" | "biblatex" | "ris", data: Record<string, unknown>): string {
  return String(plugins.output.format(style, [data as never], { format: "text" })).replace(/^\n+|\n+$/g, "");
}

// --- BibTeX and biblatex ------------------------------------------------------

// The writer's own reading of which characters it can write (lib/output/value.js):
// after NFKD, anything outside this set is written as TeX if its tables have it,
// and as nothing otherwise.
const UNSAFE = /[^a-zA-Z0-9\s!"'()*+,\-./:;=?@[\]̀-̈̊-̧̨̲̣̦̌͡]/;
const knownToTex = new Set<string>([
  ...Object.values(bibtexConfig.constants.commands),
  ...Object.values(bibtexConfig.constants.diacritics),
  ...Object.values(bibtexConfig.constants.ligatures),
  ...Object.values(bibtexConfig.constants.mathCommands),
  ..."&%$#_{}",
]);

/** Whether the classic writer would write this character as nothing: a Cyrillic letter, a kana, `ə`. */
function lostByTex(char: string): boolean {
  return [...char.normalize("NFKD")].some((part) => UNSAFE.test(part) && !knownToTex.has(part));
}

/**
 * Each character `lost` picks, in every string of `value`, as a marker of
 * ASCII letters the writer passes through untouched, and the way back: so a
 * character it has no TeX for stays in the file as UTF-8, where the writer
 * alone would write nothing. A marker is lowercase, so no title's capital
 * protection braces it apart.
 */
function marked<T>(value: T, lost: (char: string) => boolean, keep: ReadonlySet<string> = new Set()): { value: T; restore: (text: string) => string } {
  const text = JSON.stringify(value);
  let fence = "zqz";
  while (text.includes(fence)) fence += "q";
  const chars: string[] = [];
  const index = new Map<string, number>();
  const digits = (n: number) => [...String(n)].map((digit) => String.fromCharCode(97 + Number(digit))).join("");
  const mark = (input: string): string =>
    [...input]
      .map((char) => {
        if (!lost(char)) return char;
        if (!index.has(char)) {
          index.set(char, chars.length);
          chars.push(char);
        }
        return `${fence}${digits(index.get(char)!)}${fence}`;
      })
      .join("");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return mark(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, keep.has(key) ? child : walk(child)]));
    return node;
  };
  const pattern = new RegExp(`${fence}([a-j]+)${fence}`, "g");
  return {
    value: chars.length === 0 && !/[^\x00-\x7f]/.test(text) ? value : (walk(value) as T),
    restore: (written) => (chars.length === 0 ? written : written.replace(pattern, (_, code: string) => chars[Number([...code].map((c) => c.charCodeAt(0) - 97).join(""))] ?? "")),
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Adds fields before an entry's closing brace. */
function withFields(entry: string, fields: [string, string][]): string {
  if (fields.length === 0) return entry;
  const closing = entry.lastIndexOf("}");
  return `${entry.slice(0, closing)}${fields.map(([name, value]) => `\t${name} = ${value},\n`).join("")}${entry.slice(closing)}`;
}

/** An arXiv id the record keeps as its archive and its place there. */
function arxivOf(data: CslData): string | null {
  const id = typeof data.archive_location === "string" ? data.archive_location.trim() : "";
  return id && typeof data.archive === "string" && /^arxiv$/i.test(data.archive.trim()) ? id : null;
}

function writeBib(record: ExportRecord, style: "bibtex" | "biblatex"): string {
  // Both of a name's particles as BibTeX's one `von` part, which the writer alone leaves the
  // dropping one out of: read back, both are non-dropping, BibTeX having one kind.
  const data = withNames({ ...withoutKeyFields(record.data), id: record.key }, (name) => {
    const { "dropping-particle": dropping, ...rest } = name;
    return dropping ? { ...rest, "non-dropping-particle": [dropping, name["non-dropping-particle"]].filter(Boolean).join(" ") } : name;
  });
  // A character the classic writer has no TeX for, kept as UTF-8; in biblatex, every
  // character outside ASCII, which is what biber and Pandoc read. (`asciiOnly` off would
  // escape nothing at all, `&` and `%` included.)
  const lost = style === "bibtex" ? lostByTex : (char: string) => /[^\x00-\x7f]/.test(char);
  // A page range's en dash is left to the writer, which writes it `--`, every reader's range.
  const { value, restore } = marked(data, lost, new Set(["page"]));
  let entry = restore(format(style, value));

  const arxiv = arxivOf(record.data);
  if (style === "bibtex") {
    // A month as BibTeX's macro and a day as its own field: a braced value is a string, which
    // a style prints as written, and the writer puts both in one, `{jun 15}`, or a month as `{6}`.
    entry = entry.replace(/^\tmonth = \{([a-z]{3}|\d{1,2})(?: (\d{1,2}))?\},$/m, (whole, month: string, day: string | undefined) => {
      const name = /^\d+$/.test(month) ? MONTHS[Number(month) - 1] : month;
      if (!name || !MONTHS.includes(name)) return whole;
      return `\tmonth = ${name},${day ? `\n\tday = {${day}},` : ""}`;
    });
    // A chapter as `@incollection`, which the standard styles read a `booktitle` from.
    if (/^@inbook\{/.test(entry) && /^\tbooktitle = /m.test(entry)) entry = entry.replace(/^@inbook\{/, "@incollection{");
    if (arxiv) entry = withFields(entry, [["eprint", `{${arxiv}}`], ["archivePrefix", "{arXiv}"]]);
  } else if (arxiv && !/^\teprint = /m.test(entry)) {
    // Unless the writer has put a PubMed id in `eprint`, the one id it writes there.
    entry = withFields(entry, [["eprint", `{${arxiv}}`], ["eprinttype", "{arxiv}"]]);
  }
  return `${entry}\n`;
}

// --- RIS ---------------------------------------------------------------------

/** The RIS writer breaks every value after each 70 characters. */
const RIS_WRAP = 70;

function writeRis(record: ExportRecord): string {
  // A non-dropping particle joined to the family name, a dropping one after the given name,
  // "Humboldt, Alexander von", since the writer drops both; and a title's markup taken out,
  // since it writes the tags as text.
  const data: CslData = withNames({ ...withoutKeyFields(record.data), id: record.key }, (name) => {
    if (!name.family) return name;
    const { "non-dropping-particle": nonDropping, "dropping-particle": dropping, ...rest } = name;
    const family = nonDropping ? (/['’-]$/.test(nonDropping) ? `${nonDropping}${name.family}` : `${nonDropping} ${name.family}`) : name.family;
    const given = [name.given, dropping].filter(Boolean).join(" ");
    return { ...rest, family, ...(given ? { given } : {}) };
  });
  for (const field of ["title", "container-title", "collection-title"] as const) {
    if (typeof data[field] === "string") data[field] = markedText(data[field]).text;
  }
  return `${splitPages(rejoinLines(format("ris", data)))}\n`;
}

/**
 * Each value as one line again. The writer breaks a value after each 70
 * characters, inside a word as readily as between two, and Zotero joins the
 * pieces with a space. A line that follows a line holding exactly 70
 * characters of a value is more of that value (an empty one included, after a
 * value of exactly 70), and no other line is: a stored value holds no line
 * break, and a piece that reads as a tag is still a piece.
 */
export function rejoinLines(text: string): string {
  const out: string[] = [];
  let open = false;
  for (const line of text.split("\n")) {
    if (open) {
      out[out.length - 1] += line;
      open = line.length === RIS_WRAP;
    } else {
      out.push(line);
      open = /^[A-Z][A-Z0-9]  - /.test(line) && line.length - 6 === RIS_WRAP;
    }
  }
  return out.join("\n");
}

/** A page range written whole, `SP  - 635-641`, as an `SP` and an `EP` line: RIS's own form, and what Zotero writes. */
function splitPages(text: string): string {
  return text.replace(/^SP  - (\S+?)\s*[-–]\s*(\S+)$/m, "SP  - $1\nEP  - $2");
}
