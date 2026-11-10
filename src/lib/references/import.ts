import { ADS_JOURNALS } from "./ads-journals";
import { parseCslItem, readCsl, type CslData, type CslItem, type CslNote } from "./csl";
import { withoutFailedIdentifiers, type IdentifierScheme } from "./identifiers";
import { readNbib } from "./nbib";

// docs/CITATIONS.md, "The readers" — a library pasted or picked as a file,
// in whichever format its tool exports, read into CSL-JSON records, each with
// the key its source gave it.
//
// **In the browser only.** The import box and "Replace record" parse here and
// send CSL-JSON, which the server builds field by field as it does
// `create_ref`'s. So no reader is a server dependency.
//
// - **Detection is ours.** Each format's reader is called by name: a
//   library's own detection reads a URL as something to fetch.
// - **BibTeX and biblatex, RIS and `CITATION.cff`: citation-js**, loaded by a
//   dynamic import when a reader is first asked for, never in an editor or a
//   reading view; and only its synchronous forms, which fetch nothing.
// - **`.nbib`, by hand** (nbib.ts).
// - **The passes after each reader**, which mend what it misses, are here.

export type ImportFormat = "csl-json" | "bibtex" | "ris" | "nbib" | "cff";

/** What reading a record did that the preview says (docs/CITATIONS.md, "The import box"). */
export type ReadNote =
  | CslNote
  /** A field holding a bare word no `@string` defines, or nothing: `journal = PNAS`. */
  | { kind: "undefined"; field: string }
  /** An identifier that failed its check, dropped so the record is kept. */
  | { kind: "identifier"; scheme: IdentifierScheme; raw: string };

export type ImportedReference = {
  /** Which entry of the source it was, for a message: `@book{radner2012}`. */
  label: string;
  /** The key the source named (`@book{radner2012,`, a CSL `citation-key` or `id`, a RIS `ID`), as written; null for none. */
  sourceKey: string | null;
  /** biblatex's `shorthand`: the abbreviation a reference that has none takes. */
  short: string | null;
  /** The record as it will be sent and stored. */
  data: CslData;
  /** The same record read back, for the preview. */
  item: CslItem;
  notes: ReadNote[];
};

export type ImportResult = {
  format: ImportFormat | null;
  references: ImportedReference[];
  /** What couldn't be read, each naming the entry it was; or why the text isn't read at all. */
  errors: string[];
};

// --- citation-js -------------------------------------------------------------

type Chain = (data: unknown, options: { forceType: string; target?: string; generateGraph: false }) => unknown;
type Plugins = { input: { chain: Chain }; config: { get(name: string): { parse: { sentenceCase: string } } } };

let readers: Promise<Plugins> | null = null;

/** citation-js's core and the three plugins the readers use, loaded once, on first use. */
function loadReaders(): Promise<Plugins> {
  readers ??= (async () => {
    const core = (await import("@citation-js/core")) as unknown as { plugins: Plugins };
    await Promise.all([import("@citation-js/plugin-bibtex"), import("@citation-js/plugin-ris"), import("@citation-js/plugin-cff")]);
    // A title's case as written: the braces that protect capitals leave nothing behind.
    core.plugins.config.get("@bibtex").parse.sentenceCase = "never";
    return core.plugins;
  })();
  return readers;
}

/** `text` read by the named reader, synchronously, so nothing is fetched; a reader that reads nothing yields no records. */
function chain(plugins: Plugins, data: unknown, forceType: string, target?: string): unknown[] {
  const out = plugins.input.chain(data, { forceType, generateGraph: false, ...(target ? { target } : {}) });
  return Array.isArray(out) ? out : [];
}

// --- Detection ---------------------------------------------------------------

/**
 * Formats a source above also exports one we read in place of, each refused
 * with the export to use. Checked before the formats that are read, since a
 * Web of Science file's `ER` lines look like RIS's to a loose eye.
 */
const REFUSED: { test: (text: string) => boolean; message: string }[] = [
  {
    test: (text) => /^\s*(<\?xml[^>]*>\s*)?<xml>\s*<records>/i.test(text),
    message: "That is EndNote XML. In EndNote, export with the “RefMan (RIS) Export” style, or as BibTeX, and paste or pick that.",
  },
  {
    test: (text) => /^%0 /m.test(text) && /^%[TA] /m.test(text),
    message: "That is EndNote’s tagged format (.enw). In EndNote, export with the “RefMan (RIS) Export” style, or as BibTeX.",
  },
  {
    test: (text) => /^﻿?(FN (Clarivate|Thomson)|PT\tAU\t)/m.test(text) || (/^PT [A-Z]\s*$/m.test(text) && /^ER\s*$/m.test(text)),
    message: "That is Web of Science’s plain text or tab-delimited export. In Web of Science, export to “RIS (other reference software)”.",
  },
  {
    test: (text) => /^﻿?"?[A-Za-z][\w ()]*"?(,"?[A-Za-z][\w ()]*"?){2,}\s*$/m.test(text.split(/\r?\n/, 1)[0]) && /author|title/i.test(text.split(/\r?\n/, 1)[0]),
    message: "That is a CSV file, which Scopus exports. In Scopus, export as RIS or BibTeX.",
  },
  {
    test: (text) => /^RT /m.test(text) && /^(A1|T1) /m.test(text),
    message: "That is RefWorks’ tagged format. In RefWorks, export as RIS or BibTeX.",
  },
  {
    test: (text) => /^---\s*$/m.test(text) && /^\s*(references:|- id:)/m.test(text),
    message: "That is CSL-YAML. Export as CSL-JSON, BibTeX or RIS instead.",
  },
  {
    test: (text) => /<mods[\s:>]/i.test(text),
    message: "That is MODS. Export as BibTeX, RIS or CSL-JSON instead.",
  },
  {
    test: (text) => /<(marc:)?(record|collection)[\s>]/i.test(text) && /marc/i.test(text),
    message: "That is MARC. Export as RIS or BibTeX instead; library catalogues offer one or the other.",
  },
];

/** Which format `text` is, or why it isn't read. */
export function detectFormat(text: string): { format: ImportFormat } | { refused: string } | null {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return null;
  for (const refused of REFUSED) if (refused.test(trimmed)) return { refused: refused.message };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return { format: "csl-json" };
  if (/^cff-version\s*:/m.test(trimmed)) return { format: "cff" };
  if (/^PMID- /m.test(trimmed)) return { format: "nbib" };
  if (/^\s*TY\s{2}-/m.test(trimmed)) return { format: "ris" };
  if (/@\w+\s*[{(]/.test(trimmed)) return { format: "bibtex" };
  return { refused: "That isn’t BibTeX, biblatex, RIS, CSL-JSON, PubMed’s .nbib or a CITATION.cff." };
}

/** Reads pasted text, or a file's, as whichever of the formats it is. */
export async function parseReferences(text: string): Promise<ImportResult> {
  const detected = detectFormat(text);
  if (detected === null) return { format: null, references: [], errors: [] };
  if ("refused" in detected) return { format: null, references: [], errors: [detected.refused] };
  return readAs(detected.format, text);
}

/** Reads `text` with the named format's reader, whatever it holds: a URL or a DOI reads as no records. */
export async function readAs(format: ImportFormat, text: string): Promise<ImportResult> {
  const body = text.replace(/^\uFEFF/, "");
  try {
    switch (format) {
      case "csl-json":
        return finish(format, fromCslJson(body));
      case "nbib":
        return finish(format, { raw: readNbib(body).map((record) => ({ ...record, sourceKey: null, short: null, notes: [] })), errors: [] });
      case "bibtex":
        return finish(format, fromBibtex(await loadReaders(), body));
      case "ris":
        return finish(format, fromRis(await loadReaders(), body));
      case "cff":
        return finish(format, fromCff(await loadReaders(), body));
    }
  } catch (err) {
    return { format, references: [], errors: [`That doesn’t read as ${FORMAT_NAMES[format]}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`] };
  }
}

export const FORMAT_NAMES: Record<ImportFormat, string> = {
  "csl-json": "CSL-JSON",
  bibtex: "BibTeX",
  ris: "RIS",
  nbib: "a PubMed .nbib file",
  cff: "a CITATION.cff",
};

type Raw = { label: string; sourceKey: string | null; short: string | null; raw: unknown; notes: ReadNote[] };

/** Each raw record built as it will be stored, an identifier that fails its check dropped and said to be. */
function finish(format: ImportFormat, read: { raw: Raw[]; errors: string[] }): ImportResult {
  const references: ImportedReference[] = [];
  const errors = [...read.errors];
  for (const entry of read.raw) {
    const parsed = parseCslItem(entry.raw);
    if (!parsed.ok) {
      errors.push(`${entry.label}: ${parsed.error}`);
      continue;
    }
    const { data, dropped } = withoutFailedIdentifiers(parsed.item);
    references.push({
      label: entry.label,
      sourceKey: entry.sourceKey,
      short: entry.short,
      data,
      item: readCsl(data),
      notes: [...entry.notes, ...parsed.notes, ...dropped.map((id): ReadNote => ({ kind: "identifier", ...id }))],
    });
  }
  return { format, references, errors };
}

// --- CSL-JSON ----------------------------------------------------------------

/** A CSL item's key: its `citation-key`, or an `id` that isn't a URL, which is where Zotero writes an item's URI when it has no key. */
function cslSourceKey(item: Record<string, unknown>): string | null {
  const key = typeof item["citation-key"] === "string" ? item["citation-key"] : typeof item.id === "string" ? item.id : null;
  if (!key?.trim() || /^[a-z][a-z0-9+.-]*:\/\//i.test(key.trim())) return null;
  return key.trim();
}

function fromCslJson(text: string): { raw: Raw[]; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { raw: [], errors: [`That JSON doesn’t parse: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const items = Array.isArray(value) ? value : [value];
  return {
    raw: items.map((item, index) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
      return { label: `Item ${index + 1}`, sourceKey: cslSourceKey(record), short: null, raw: item, notes: [] };
    }),
    errors: [],
  };
}

// --- BibTeX and biblatex -----------------------------------------------------

type BibEntry = { type: string; label: string; properties: Record<string, unknown> };

/** The entries of a `.bib`, each as citation-js reads it before mapping, and the CSL it maps them to: one pass, so `crossref` resolves across the file. */
function readBib(plugins: Plugins, text: string): { entries: BibEntry[]; items: Record<string, unknown>[] } {
  const entries = chain(plugins, text, "@biblatex/text", "@biblatex/entries+list") as BibEntry[];
  const items = entries.length > 0 ? (chain(plugins, entries, "@biblatex/entries+list") as Record<string, unknown>[]) : [];
  return { entries, items };
}

/**
 * The file's entries one at a time, each after the file's `@string`s, when
 * the file as a whole doesn't parse: an entry that doesn't parse is reported,
 * and the rest are read. `crossref` doesn't reach across entries here.
 */
function readBibByEntry(plugins: Plugins, text: string): { pairs: { entry: BibEntry; item: Record<string, unknown> }[]; errors: string[] } {
  const starts = [...text.matchAll(/^[ \t]*@(\w+)\s*[{(]/gm)];
  const chunks = starts.map((start, i) => ({ type: start[1].toLowerCase(), text: text.slice(start.index, starts[i + 1]?.index ?? text.length) }));
  const strings = chunks.filter((chunk) => chunk.type === "string").map((chunk) => chunk.text).join("\n");
  const pairs: { entry: BibEntry; item: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  for (const chunk of chunks) {
    if (["string", "comment", "preamble"].includes(chunk.type)) continue;
    try {
      const { entries, items } = readBib(plugins, `${strings}\n${chunk.text}`);
      entries.forEach((entry, i) => items[i] && pairs.push({ entry, item: items[i] }));
    } catch {
      errors.push(`The @${chunk.type} entry starting “${chunk.text.slice(0, 40).replace(/\s+/g, " ")}…” doesn’t parse.`);
    }
  }
  return { pairs, errors };
}

const NAME_FIELDS = ["author", "editor", "translator", "collection-editor", "container-author", "contributor", "compiler", "director", "illustrator", "interviewer", "recipient", "reviewed-author", "original-author"];

/** `and others`, which a reader gives as an author named "others": dropped, since "et al." is what a list past its length already says. */
function withoutOthers(item: Record<string, unknown>): void {
  for (const field of NAME_FIELDS) {
    const names = item[field];
    if (!Array.isArray(names)) continue;
    item[field] = names.filter((name) => !(name && typeof name === "object" && /^others$/i.test(String((name as { family?: unknown; literal?: unknown }).family ?? (name as { literal?: unknown }).literal ?? ""))));
  }
}

/** What citation-js misses in a `.bib` entry, mended from the entry as written. */
function mendBib(entry: BibEntry, item: Record<string, unknown>): { short: string | null; notes: ReadNote[] } {
  const props = entry.properties;
  const prop = (name: string) => (typeof props[name] === "string" || typeof props[name] === "number" ? String(props[name]).trim() : "");
  const notes: ReadNote[] = [];
  withoutOthers(item);

  // An arXiv id: arXiv's own form, `archivePrefix`, or biblatex's, `eprinttype`.
  const eprint = prop("eprint");
  if (eprint && /^arxiv$/i.test(prop("archiveprefix") || prop("eprinttype"))) {
    item.archive = "arXiv";
    item.archive_location = eprint.replace(/^arxiv:/i, "");
  }

  // ADS's journal macros, which only AASTeX defines.
  const container = typeof item["container-title"] === "string" ? item["container-title"] : "";
  const macro = /^\\([a-z]+)$/i.exec(container.trim());
  if (macro) {
    const journal = ADS_JOURNALS[macro[1].toLowerCase()];
    if (journal) item["container-title"] = journal;
    else {
      delete item["container-title"];
      notes.push({ kind: "undefined", field: "journal" });
    }
  }

  // A bare word no `@string` defines reads as nothing.
  for (const [field, value] of Object.entries(props)) {
    if (value === "" && !notes.some((note) => note.kind === "undefined" && note.field === field)) notes.push({ kind: "undefined", field });
  }

  // `month = jun # "~15"`, BibTeX's manual's form, which the entries hold as `06~15` and the mapping reads as a year alone.
  const day = /^(\d{1,2})~(\d{1,2})$/.exec(prop("month"));
  const issued = item.issued as { "date-parts"?: unknown[][] } | undefined;
  const year = issued?.["date-parts"]?.[0]?.[0];
  if (day && typeof year === "number" && issued?.["date-parts"]?.[0]?.length === 1) {
    item.issued = { "date-parts": [[year, Number(day[1]), Number(day[2])]] };
  }

  return { short: prop("shorthand") || null, notes };
}

function fromBibtex(plugins: Plugins, text: string): { raw: Raw[]; errors: string[] } {
  let pairs: { entry: BibEntry; item: Record<string, unknown> }[];
  let errors: string[] = [];
  try {
    const { entries, items } = readBib(plugins, text);
    pairs = entries.flatMap((entry, i) => (items[i] ? [{ entry, item: items[i] }] : []));
  } catch {
    ({ pairs, errors } = readBibByEntry(plugins, text));
  }
  const raw = pairs.map(({ entry, item }) => {
    const { short, notes } = mendBib(entry, item);
    return { label: `@${entry.type}{${entry.label}}`, sourceKey: entry.label?.trim() || null, short, raw: item, notes };
  });
  if (raw.length === 0 && errors.length === 0) errors.push("No BibTeX entry in that reads.");
  return { raw, errors };
}

// --- RIS ---------------------------------------------------------------------

function fromRis(plugins: Plugins, text: string): { raw: Raw[]; errors: string[] } {
  const items = chain(plugins, text, "@ris/file") as Record<string, unknown>[];
  const raw = items.map((item, index) => {
    // Two `SN` lines come as a list, as can any repeated text field: one value, joined.
    for (const [field, value] of Object.entries(item)) {
      if (Array.isArray(value) && value.every((part) => typeof part === "string" || typeof part === "number") && !NAME_FIELDS.includes(field)) {
        item[field] = [...new Set(value.map(String))].join(", ");
      }
    }
    const sourceKey = typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
    const title = typeof item.title === "string" ? item.title : "";
    return { label: `RIS record ${index + 1}${title ? ` “${title.slice(0, 40)}”` : ""}`, sourceKey, short: null, raw: item, notes: [] };
  });
  return { raw, errors: raw.length === 0 ? ["No RIS record in that reads."] : [] };
}

// --- CITATION.cff ------------------------------------------------------------

/**
 * The file's own work: the record the plugin marks as the main reference,
 * and never the works in its `references` list, which are what the software
 * cites. It comes with no type, and is software.
 */
function fromCff(plugins: Plugins, text: string): { raw: Raw[]; errors: string[] } {
  const items = chain(plugins, text, "@else/yaml") as Record<string, unknown>[];
  const main = items.find((item) => item._cff_mainReference === true);
  if (!main) return { raw: [], errors: ["That CITATION.cff names no work of its own."] };
  const { _cff_mainReference: _main, ...record } = main;
  void _main;
  return { raw: [{ label: "The CITATION.cff", sourceKey: null, short: null, raw: { ...record, type: typeof record.type === "string" ? record.type : "software" }, notes: [] }], errors: [] };
}
