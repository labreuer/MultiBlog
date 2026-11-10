import { parseCslItem, readCsl, type CslData, type CslItem, type CslName, type CslNote } from "./csl";

// docs/CITATIONS.md, "Who writes them" — references are imported by pasting
// BibTeX, RIS or CSL-JSON, one item or many. This reads any of the three into
// CSL-JSON items, each with the key its source gave it, if any.
//
// Hand-written rather than a dependency: the three formats are small, the
// subset bibliographies actually use is smaller, and what a parser gets wrong
// here is visible on the next screen, where each record is listed before
// anything is kept. Pure and browser-safe.

export type ImportedReference = {
  /** The key the source named (`@book{radner2012,`, a CSL `id`), as written; null for none. */
  key: string | null;
  /** The record as it will be stored. */
  data: CslData;
  /** The same record read back, for the preview. */
  item: CslItem;
  /** What the parse cut, dropped or read as something else. */
  notes: CslNote[];
};

export type ImportResult = {
  format: "csl-json" | "bibtex" | "ris" | null;
  references: ImportedReference[];
  /** What couldn't be read, each naming the entry it was. */
  errors: string[];
};

/** Reads pasted text as whichever of the three formats it is. */
export function parseReferences(text: string): ImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { format: null, references: [], errors: [] };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return fromCslJson(trimmed);
  if (/^\s*TY\s{2}-/m.test(trimmed)) return fromRis(trimmed);
  if (/@\w+\s*[{(]/.test(trimmed)) return fromBibtex(trimmed);
  return { format: null, references: [], errors: ["That isn't BibTeX, RIS or CSL-JSON."] };
}

function finish(format: ImportResult["format"], raw: { key: string | null; fields: unknown; label: string }[]): ImportResult {
  const references: ImportedReference[] = [];
  const errors: string[] = [];
  for (const entry of raw) {
    const parsed = parseCslItem(entry.fields);
    if (parsed.ok) references.push({ key: entry.key?.trim() || null, data: parsed.item, item: readCsl(parsed.item), notes: parsed.notes });
    else errors.push(`${entry.label}: ${parsed.error}`);
  }
  return { format, references, errors };
}

// --- CSL-JSON ----------------------------------------------------------------

function fromCslJson(text: string): ImportResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { format: "csl-json", references: [], errors: [`That JSON doesn't parse: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const items = Array.isArray(value) ? value : [value];
  return finish(
    "csl-json",
    items.map((item, index) => ({
      key: item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : null,
      fields: item,
      label: `Item ${index + 1}`,
    })),
  );
}

// --- BibTeX ------------------------------------------------------------------

const BIBTEX_TYPES: Record<string, string> = {
  article: "article-journal",
  book: "book",
  booklet: "book",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  proceedings: "collection",
  collection: "collection",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  online: "webpage",
  misc: "document",
  unpublished: "document",
};

// The accents BibTeX files spell out, as the letters they mean. Anything else
// in braces is kept as its letters, which is what a reader would have seen.
const ACCENTS: Record<string, Record<string, string>> = {
  "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ć", n: "ń", s: "ś", z: "ź", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" },
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È" },
  '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", A: "Ä", O: "Ö", U: "Ü" },
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û" },
  "~": { n: "ñ", a: "ã", o: "õ", N: "Ñ" },
  c: { c: "ç", C: "Ç", s: "ş" },
  v: { c: "č", s: "š", z: "ž", r: "ř", e: "ě", C: "Č", S: "Š", Z: "Ž" },
};

function untex(value: string): string {
  return value
    .replace(/\\([`'"^~])\s*\{?\\?([a-zA-Z])\}?/g, (whole, accent: string, letter: string) => ACCENTS[accent]?.[letter] ?? letter)
    .replace(/\\([cv])\s*\{([a-zA-Z])\}/g, (whole, accent: string, letter: string) => ACCENTS[accent]?.[letter] ?? letter)
    .replace(/\\ss\b\s?/g, "ß")
    .replace(/\\(?:o|O)\b\s?/g, (m) => (m.includes("O") ? "Ø" : "ø"))
    .replace(/\\(?:ae|AE)\b\s?/g, (m) => (m.includes("AE") ? "Æ" : "æ"))
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/~/g, " ")
    .replace(/\\(?:emph|textit|textbf|textsc|mbox|url)\s*\{([^{}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Family, Given and Given Family and {A Corporate Name}" as CSL names. */
function bibtexNames(value: string): CslName[] {
  const names: CslName[] = [];
  // Split on " and " outside braces.
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  const words = value.split(/(\s+and\s+|[{}])/i);
  for (const word of words) {
    if (word === "{") depth++;
    if (word === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && /^\s+and\s+$/i.test(word)) {
      parts.push(current);
      current = "";
    } else {
      current += word;
    }
  }
  parts.push(current);
  for (const raw of parts) {
    const part = raw.trim();
    if (!part || /^others$/i.test(part)) continue;
    if (/^\{.*\}$/.test(part)) {
      names.push({ literal: untex(part) });
    } else if (part.includes(",")) {
      const [family, ...given] = part.split(",");
      names.push({ family: untex(family), ...(given.join(",").trim() ? { given: untex(given.join(",")) } : {}) });
    } else {
      const tokens = untex(part).split(" ");
      // The family name starts at the first lowercase particle ("van", "de"), or is the last word.
      let split = tokens.findIndex((token, index) => index > 0 && index < tokens.length - 1 && /^[a-z]/.test(token));
      if (split === -1) split = tokens.length - 1;
      const family = tokens.slice(split).join(" ");
      const given = tokens.slice(0, split).join(" ");
      names.push(given ? { family, given } : { family });
    }
  }
  return names;
}

/** One `@type{key, field = value, …}` entry, read from `text` at `at`. */
function readBibtexEntry(text: string, at: number): { type: string; key: string; fields: Record<string, string>; end: number } | null {
  const head = /@(\w+)\s*([{(])/y;
  head.lastIndex = at;
  const opened = head.exec(text);
  if (!opened) return null;
  const close = opened[2] === "{" ? "}" : ")";
  let pos = head.lastIndex;
  const keyEnd = text.indexOf(",", pos);
  if (keyEnd === -1) return null;
  const key = text.slice(pos, keyEnd).trim();
  pos = keyEnd + 1;
  const fields: Record<string, string> = {};
  for (;;) {
    while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
    if (pos >= text.length) return null;
    if (text[pos] === close) return { type: opened[1].toLowerCase(), key, fields, end: pos + 1 };
    const name = /[\w-]+/y;
    name.lastIndex = pos;
    const named = name.exec(text);
    if (!named) return null;
    pos = name.lastIndex;
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (text[pos] !== "=") return null;
    pos++;
    // A value is one or more pieces joined by #: {braced}, "quoted", or a bare word or number.
    let value = "";
    for (;;) {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      if (text[pos] === "{") {
        let depth = 0;
        const start = pos;
        for (; pos < text.length; pos++) {
          if (text[pos] === "{") depth++;
          else if (text[pos] === "}" && --depth === 0) break;
        }
        if (pos >= text.length) return null;
        value += text.slice(start + 1, pos);
        pos++;
      } else if (text[pos] === '"') {
        let depth = 0;
        const start = ++pos;
        for (; pos < text.length; pos++) {
          if (text[pos] === "{") depth++;
          else if (text[pos] === "}") depth--;
          else if (text[pos] === '"' && depth === 0) break;
        }
        if (pos >= text.length) return null;
        value += text.slice(start, pos);
        pos++;
      } else {
        const bare = /[^\s,#})]+/y;
        bare.lastIndex = pos;
        const word = bare.exec(text);
        if (!word) return null;
        value += word[0];
        pos = bare.lastIndex;
      }
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      if (text[pos] !== "#") break;
      pos++;
    }
    fields[named[0].toLowerCase()] = value;
  }
}

function fromBibtex(text: string): ImportResult {
  const raw: { key: string | null; fields: unknown; label: string }[] = [];
  const errors: string[] = [];
  const starts = /@(\w+)\s*[{(]/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(text))) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "preamble" || type === "string") continue;
    const entry = readBibtexEntry(text, match.index);
    if (!entry) {
      errors.push(`The @${type} entry starting "${text.slice(match.index, match.index + 40).replace(/\s+/g, " ")}…" doesn't parse.`);
      continue;
    }
    starts.lastIndex = entry.end;
    const f = entry.fields;
    const field = (name: string) => (f[name] === undefined ? undefined : untex(f[name]));
    const year = field("year") ?? /\d{4}/.exec(field("date") ?? "")?.[0];
    raw.push({
      key: entry.key || null,
      label: `@${entry.type}{${entry.key}}`,
      fields: {
        type: BIBTEX_TYPES[entry.type] ?? "document",
        title: field("title"),
        author: f.author ? bibtexNames(f.author) : undefined,
        editor: f.editor ? bibtexNames(f.editor) : undefined,
        issued: year,
        "container-title": field("journal") ?? field("journaltitle") ?? field("booktitle"),
        "collection-title": field("series"),
        publisher: field("publisher") ?? field("school") ?? field("institution"),
        "publisher-place": field("address") ?? field("location"),
        volume: field("volume"),
        issue: field("number") ?? field("issue"),
        page: field("pages"),
        edition: field("edition"),
        DOI: field("doi"),
        ISBN: field("isbn"),
        URL: field("url"),
        abstract: field("abstract"),
        note: field("note"),
      },
    });
  }
  const result = finish("bibtex", raw);
  return { ...result, errors: [...errors, ...result.errors] };
}

// --- RIS ---------------------------------------------------------------------

const RIS_TYPES: Record<string, string> = {
  JOUR: "article-journal",
  MGZN: "article-magazine",
  NEWS: "article-newspaper",
  BOOK: "book",
  EBOOK: "book",
  EDBOOK: "collection",
  CHAP: "chapter",
  ECHAP: "chapter",
  CONF: "paper-conference",
  CPAPER: "paper-conference",
  RPRT: "report",
  THES: "thesis",
  ELEC: "webpage",
  ENCYC: "entry-encyclopedia",
};

function risName(value: string): CslName {
  const [family, ...given] = value.split(",").map((part) => part.trim());
  return given.join(" ").trim() ? { family, given: given.join(" ").trim() } : family.includes(" ") ? { literal: family } : { family };
}

function fromRis(text: string): ImportResult {
  const raw: { key: string | null; fields: unknown; label: string }[] = [];
  let current: Record<string, string[]> | null = null;
  const flush = () => {
    if (!current) return;
    const one = (...tags: string[]) => tags.map((tag) => current![tag]?.[0]).find((value) => value !== undefined);
    const all = (...tags: string[]) => tags.flatMap((tag) => current![tag] ?? []);
    const start = one("SP");
    const end = one("EP");
    const chapter = (current.TY?.[0] ?? "") === "CHAP" || (current.TY?.[0] ?? "") === "ECHAP";
    raw.push({
      key: one("ID") ?? null,
      label: `The ${current.TY?.[0] ?? "RIS"} record "${(one("TI", "T1") ?? "").slice(0, 40)}"`,
      fields: {
        type: RIS_TYPES[current.TY?.[0] ?? ""] ?? "document",
        title: one("TI", "T1"),
        author: all("AU", "A1").map(risName),
        editor: all("A2", "ED").map(risName),
        issued: one("PY", "Y1", "DA"),
        "container-title": one("JO", "JF", "T2", "BT"),
        "collection-title": chapter ? undefined : one("T3"),
        publisher: one("PB"),
        "publisher-place": one("CY"),
        volume: one("VL"),
        issue: one("IS"),
        page: start && end ? `${start}-${end}` : start,
        edition: one("ET"),
        DOI: one("DO"),
        ISBN: chapter ? undefined : one("SN"),
        URL: one("UR"),
        abstract: one("AB", "N2"),
      },
    });
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const tagged = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(line);
    if (!tagged) continue;
    const [, tag, value] = tagged;
    if (tag === "TY") {
      flush();
      current = { TY: [value.trim()] };
    } else if (tag === "ER") {
      flush();
    } else if (current && value.trim()) {
      (current[tag] ??= []).push(value.trim());
    }
  }
  flush();
  return finish("ris", raw);
}
