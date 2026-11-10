import { slugify } from "../slug";
import { decodeCharacterReferences, markedText, markupOf, stripTags, type MarkedText } from "./markup";

// docs/CITATIONS.md, "Records" and "What a record keeps" — a reference's
// bibliographic record is a CSL-JSON item (the shape citeproc, Zotero and
// Pandoc share), kept as jsonb. This is the parse every way in runs, the
// shape a stored record is read back as, and the handful of accessors labels
// and the bibliography are built from.
//
// Pure and browser-safe.

export type CslName = {
  family?: string;
  given?: string;
  literal?: string;
  "non-dropping-particle"?: string;
  "dropping-particle"?: string;
  suffix?: string;
};
export type CslDate = { "date-parts"?: number[][]; season?: string; circa?: true; literal?: string };

/** The three fields whose markup is kept (What a record keeps, "Markup in a field"). */
export const TITLE_FIELDS = ["title", "container-title", "collection-title"] as const;
type TitleField = (typeof TITLE_FIELDS)[number];

/** The fields MultiBlog reads by name, in either form of a record. */
type CslFields = {
  type: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: CslDate;
  DOI?: string;
  ISBN?: string;
  URL?: string;
  "publisher-place"?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  edition?: string;
};

/**
 * A record as stored, and as a download writes it: every field a string but
 * the names and dates, the three title fields holding their markup as
 * CSL-JSON's tags.
 */
export type CslData = CslFields & { [F in TitleField]?: string } & { [field: string]: unknown };

/**
 * A record read back (`cslOf`): the same fields, but each title field as its
 * text and its runs, a type no string slot takes, so every reader chooses
 * which it shows. A title's tags shown as written would fail no check.
 */
export type CslItem = CslFields & { [F in TitleField]?: MarkedText } & { [field: string]: unknown };

/** A record is a page of metadata; anything bigger is not one. Measured once its fields are chosen. */
const MAX_ITEM_LENGTH = 20_000;
const MAX_FIELD_LENGTH = 4_000;
const MAX_NAMES = 200;

/** The 45 item types of CSL 1.0.2. A type it doesn't list is kept as `document`, and the preview says so. */
export const CSL_TYPES = [
  "article",
  "article-journal",
  "article-magazine",
  "article-newspaper",
  "bill",
  "book",
  "broadcast",
  "chapter",
  "classic",
  "collection",
  "dataset",
  "document",
  "entry",
  "entry-dictionary",
  "entry-encyclopedia",
  "event",
  "figure",
  "graphic",
  "hearing",
  "interview",
  "legal_case",
  "legislation",
  "manuscript",
  "map",
  "motion_picture",
  "musical_score",
  "pamphlet",
  "paper-conference",
  "patent",
  "performance",
  "periodical",
  "personal_communication",
  "post",
  "post-weblog",
  "regulation",
  "report",
  "review",
  "review-book",
  "software",
  "song",
  "speech",
  "standard",
  "thesis",
  "treaty",
  "webpage",
] as const;

/** CSL 1.0.2's name variables. */
const NAME_FIELDS = [
  "author",
  "chair",
  "collection-editor",
  "compiler",
  "composer",
  "container-author",
  "contributor",
  "curator",
  "director",
  "editor",
  "editorial-director",
  "executive-producer",
  "guest",
  "host",
  "interviewer",
  "illustrator",
  "narrator",
  "organizer",
  "original-author",
  "performer",
  "producer",
  "recipient",
  "reviewed-author",
  "script-writer",
  "series-creator",
  "translator",
] as const;

/** CSL 1.0.2's date variables. */
const DATE_FIELDS = ["accessed", "available-date", "event-date", "issued", "original-date", "submitted"] as const;

/**
 * CSL 1.0.2's text and number variables, kept as text. Left out: the five a
 * processor computes for a citation rather than a record holds for a work
 * (`citation-label`, `citation-number`, `first-reference-note-number`,
 * `locator`, `year-suffix`), and `id` and `citation-key`, which are the
 * reference's key and are written from it on the way out.
 */
const TEXT_FIELDS = [
  "abstract",
  "annote",
  "archive",
  "archive_collection",
  "archive_location",
  "archive-place",
  "authority",
  "call-number",
  "chapter-number",
  "collection-number",
  "collection-title",
  "container-title",
  "container-title-short",
  "dimensions",
  "division",
  "DOI",
  "edition",
  "event",
  "event-title",
  "event-place",
  "genre",
  "ISBN",
  "ISSN",
  "issue",
  "jurisdiction",
  "keyword",
  "language",
  "license",
  "medium",
  "note",
  "number",
  "number-of-pages",
  "number-of-volumes",
  "original-publisher",
  "original-publisher-place",
  "original-title",
  "page",
  "page-first",
  "part",
  "part-title",
  "PMCID",
  "PMID",
  "printing",
  "publisher",
  "publisher-place",
  "references",
  "reviewed-genre",
  "reviewed-title",
  "scale",
  "section",
  "source",
  "status",
  "supplement",
  "title",
  "title-short",
  "URL",
  "version",
  "volume",
  "volume-title",
  "volume-title-short",
] as const;

/** Older names Zotero and citeproc-js still write, read as the variable they became. */
const LEGACY_FIELDS: Record<string, string> = { journalAbbreviation: "container-title-short", shortTitle: "title-short" };

/** Fields a record carries that say nothing about the work, so their loss is not reported. */
const UNREPORTED_FIELDS = new Set(["id", "citation-key", "type", "custom", "categories", "_cff_mainReference"]);

const KNOWN_FIELDS = new Set<string>([...NAME_FIELDS, ...DATE_FIELDS, ...TEXT_FIELDS, ...Object.keys(LEGACY_FIELDS)]);

/** What the parse did to a record that the preview reports (docs/CITATIONS.md, "The import box"). */
export type CslNote =
  | { kind: "cut"; field: string }
  | { kind: "dropped"; field: string }
  | { kind: "mapped"; field: "type"; from: string; to: string };

export type CslParse = { ok: true; item: CslData; notes: CslNote[] } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Reading = { decode: boolean; cut: (field: string) => void };

/** A run of white space, a paragraph break included, as one space. */
const squash = (value: string) => value.replace(/\s+/g, " ").trim();

/** A plain field: references decoded, tags taken out (Crossref's abstracts are JATS), bounded. */
function plainText(value: unknown, field: string, reading: Reading): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const decoded = reading.decode ? decodeCharacterReferences(value) : value;
  const text = squash(stripTags(decoded));
  if (!text) return undefined;
  if (text.length > MAX_FIELD_LENGTH) {
    reading.cut(field);
    return text.slice(0, MAX_FIELD_LENGTH).trimEnd();
  }
  return text;
}

/** A title field: its kept tags in their one spelling, the rest taken out, its text bounded. */
function titleText(value: unknown, field: string, reading: Reading): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const decoded = reading.decode ? decodeCharacterReferences(value) : value;
  const marked = markedText(decoded.replace(/\s+/g, " "));
  if (!marked.text.trim()) return undefined;
  const bounded = marked.text.length > MAX_FIELD_LENGTH ? (reading.cut(field), markedText(markupOf(marked.runs, MAX_FIELD_LENGTH))) : marked;
  return markupOf(bounded.runs).trim() || undefined;
}

function nameText(value: unknown, reading: Reading): string | undefined {
  // A name's parts are short; their bound is a field's, and a cut part isn't worth reporting apart from its list.
  return plainText(value, "name", { ...reading, cut: () => {} });
}

function names(value: unknown, field: string, reading: Reading): CslName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_NAMES) reading.cut(field);
  const out: CslName[] = [];
  for (const entry of value.slice(0, MAX_NAMES)) {
    if (!isRecord(entry)) continue;
    const family = nameText(entry.family, reading);
    const given = nameText(entry.given, reading);
    const literal = nameText(entry.literal, reading);
    if (family) {
      const name: CslName = { family };
      if (given) name.given = given;
      for (const part of ["non-dropping-particle", "dropping-particle", "suffix"] as const) {
        const text = nameText(entry[part], reading);
        if (text) name[part] = text;
      }
      out.push(name);
    } else if (literal ?? given) out.push({ literal: (literal ?? given)! });
  }
  return out.length > 0 ? out : undefined;
}

/** One date's parts: a year, then a month and a day when known. */
function dateParts(row: unknown): number[] | null {
  if (!Array.isArray(row)) return null;
  const parts: number[] = [];
  for (const raw of row.slice(0, 3)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || raw === "" || raw === null) break;
    parts.push(n);
  }
  if (parts.length === 0 || parts[0] <= 0 || parts[0] >= 10_000) return null;
  if (parts[1] !== undefined && (parts[1] < 1 || parts[1] > 12)) parts.length = 1;
  if (parts[2] !== undefined && (parts[2] < 1 || parts[2] > 31)) parts.length = 2;
  return parts;
}

function date(value: unknown, reading: Reading): CslDate | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const iso = /^\s*(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?\b/.exec(String(value));
    const parts = iso ? dateParts([iso[1], iso[2] ?? "", iso[3] ?? ""]) : null;
    if (parts) return { "date-parts": [parts] };
    const year = /\b(\d{4})\b/.exec(String(value));
    return year ? { "date-parts": [[Number(year[1])]] } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const rows = Array.isArray(value["date-parts"]) ? value["date-parts"] : [];
  // A range is two dates; past it, nothing is a date.
  const parts = rows.slice(0, 2).map(dateParts);
  if (parts[0]) {
    const out: CslDate = { "date-parts": parts.filter((row): row is number[] => row !== null) };
    const season = plainText(value.season, "season", reading);
    if (season) out.season = season;
    if (value.circa === true || value.circa === 1 || value.circa === "1" || value.circa === "true") out.circa = true;
    return out;
  }
  return date(value.literal ?? value.raw, reading);
}

/**
 * A CSL item from an untrusted value, or the reason it isn't one. Every
 * variable of CSL 1.0.2 is kept by its schema type (text, names, date), each
 * bounded, and anything else is dropped: a record is stored as jsonb and
 * shown on a public page, so it is built field by field and never passed
 * through. `notes` says what was cut, dropped or read as something else.
 *
 * A title is the one thing every record must have: a reference with none
 * can't be listed, cited by name, or told from another.
 *
 * `decode` is off for a stored record read back, whose character references
 * were decoded when it was stored: decoding twice would read an `&amp;`
 * the record holds as text.
 */
export function parseCslItem(raw: unknown, options: { decode?: boolean } = {}): CslParse {
  if (!isRecord(raw)) return { ok: false, error: "A reference is an object of CSL-JSON fields." };
  const notes: CslNote[] = [];
  const reading: Reading = {
    decode: options.decode ?? true,
    cut: (field) => {
      if (!notes.some((note) => note.kind === "cut" && note.field === field)) notes.push({ kind: "cut", field });
    },
  };

  const rawType = typeof raw.type === "string" ? raw.type : "";
  const type = (CSL_TYPES as readonly string[]).includes(rawType) ? rawType : "document";
  if (type !== rawType) notes.push({ kind: "mapped", field: "type", from: rawType || "(none)", to: type });
  const item: CslData = { type };

  for (const field of TEXT_FIELDS) {
    const value = (TITLE_FIELDS as readonly string[]).includes(field) ? titleText(raw[field], field, reading) : plainText(raw[field], field, reading);
    if (value !== undefined) item[field] = value;
  }
  for (const [legacy, field] of Object.entries(LEGACY_FIELDS)) {
    const value = plainText(raw[legacy], field, reading);
    if (value !== undefined && item[field] === undefined) item[field] = value;
  }
  // A page range is written with an en dash, as every label writes one.
  if (item.page) item.page = item.page.replace(/\s*-{1,2}\s*/g, "–");
  for (const field of NAME_FIELDS) {
    const value = names(raw[field], field, reading);
    if (value) item[field] = value;
  }
  for (const field of DATE_FIELDS) {
    const value = date(raw[field], reading);
    if (value) item[field] = value;
  }
  for (const field of Object.keys(raw).slice(0, 200)) {
    if (!KNOWN_FIELDS.has(field) && !UNREPORTED_FIELDS.has(field) && raw[field] !== undefined && raw[field] !== null && raw[field] !== "") {
      notes.push({ kind: "dropped", field });
    }
  }

  if (!item.title) return { ok: false, error: "A reference needs a title." };
  if (JSON.stringify(item).length > MAX_ITEM_LENGTH) return { ok: false, error: "That record is too large to be one reference." };
  return { ok: true, item, notes };
}

/** A stored record's three title fields as text and runs: what every reader of a record is handed. */
export function readCsl(data: CslData): CslItem {
  const item = { ...data } as unknown as CslItem;
  for (const field of TITLE_FIELDS) {
    const value = data[field];
    if (typeof value === "string") item[field] = markedText(value);
    else delete item[field];
  }
  return item;
}

/** A stored record read back: a column is untrusted input whoever wrote it. Null for one that no longer parses. */
export function cslOf(raw: unknown): CslItem | null {
  const parsed = parseCslItem(raw, { decode: false });
  return parsed.ok ? readCsl(parsed.item) : null;
}

/** A stored record as its stored form, re-parsed: what a download writes. Null for one that no longer parses. */
export function cslDataOf(raw: unknown): CslData | null {
  const parsed = parseCslItem(raw, { decode: false });
  return parsed.ok ? parsed.item : null;
}

/** A title field's text, or "" for none. */
export const titleOf = (item: CslItem, field: TitleField = "title"): string => item[field]?.text ?? "";

/** The people a label names: the authors, or the editors of a work that has none. */
export function creatorsOf(item: Pick<CslItem, "author" | "editor">): CslName[] {
  return item.author?.length ? item.author : (item.editor ?? []);
}

/** A particle joined to what follows it: with a space, unless it ends in an apostrophe or a hyphen ("d'Alembert"). */
export function withParticle(particle: string | undefined, rest: string): string {
  if (!particle) return rest;
  return /['’-]$/.test(particle) ? `${particle}${rest}` : `${particle} ${rest}`;
}

/**
 * The family name as every use of a name reads it: with its non-dropping
 * particle, "van Beethoven", in a label, an entry, the bibliography's order
 * and a made key, as APA has it. "" for a name that isn't split.
 */
export function familyName(name: CslName): string {
  return name.family ? withParticle(name["non-dropping-particle"], name.family) : "";
}

/** A name as a label shows it: the family name, or the whole of a name that isn't split. */
export function shortName(name: CslName): string {
  return familyName(name) || name.literal || "";
}

/** The year, or null for an undated work. */
export function yearOf(item: Pick<CslItem, "issued">): number | null {
  const year = Number(item.issued?.["date-parts"]?.[0]?.[0]);
  return Number.isInteger(year) && year > 0 ? year : null;
}

/**
 * The names a short citation gives: one, "A and B", or "A et al." for three
 * or more. Empty for a work with no creator, which a label then names by its
 * title.
 */
export function citedNames(item: Pick<CslItem, "author" | "editor">): string {
  const creators = creatorsOf(item).map(shortName).filter(Boolean);
  if (creators.length === 0) return "";
  if (creators.length === 1) return creators[0];
  if (creators.length === 2) return `${creators[0]} and ${creators[1]}`;
  return `${creators[0]} et al.`;
}

/** Text as ASCII letters and digits: accents taken off first, so "Müller" is "muller" and not "mller". */
const asciiSlug = (text: string, fallback: string) => slugify(text.normalize("NFD").replace(/\p{M}/gu, ""), fallback);

/**
 * The start of a key for a record that arrives without one, or whose own
 * key can't be kept: the first creator's family name and the year,
 * `radner2012`, as BibTeX keys are conventionally made. A work with no
 * creator is keyed by its title's first word.
 */
export function keyBaseOf(item: CslItem): string {
  const first = creatorsOf(item)[0];
  const who = asciiSlug(first ? shortName(first) : titleOf(item).split(/\s+/)[0], "ref").replace(/-/g, "");
  return `${who || "ref"}${yearOf(item) ?? ""}`;
}
