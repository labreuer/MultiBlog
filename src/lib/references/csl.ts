import { slugify } from "../slug";

// docs/CITATIONS.md, "Records" — a reference's bibliographic record is a
// CSL-JSON item (the shape citeproc, Zotero and Pandoc share), kept as jsonb.
// This is its shape as far as MultiBlog reads it, the parse every way in runs,
// and the handful of accessors labels and the bibliography are built from.
//
// Pure and browser-safe.

export type CslName = { family?: string; given?: string; literal?: string };
export type CslDate = { "date-parts"?: (number | string)[][]; literal?: string; raw?: string };

export type CslItem = {
  type: string;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: CslDate;
  "container-title"?: string;
  "collection-title"?: string;
  publisher?: string;
  "publisher-place"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  edition?: string;
  DOI?: string;
  ISBN?: string;
  URL?: string;
  [field: string]: unknown;
};

/** A record is a page of metadata; anything bigger is not one. */
const MAX_ITEM_LENGTH = 20_000;
const MAX_FIELD_LENGTH = 4_000;
const MAX_NAMES = 200;

/** The CSL types this library takes. A type it doesn't list is kept as `document`. */
export const CSL_TYPES = [
  "article-journal",
  "article-magazine",
  "article-newspaper",
  "book",
  "chapter",
  "collection",
  "document",
  "entry-encyclopedia",
  "paper-conference",
  "report",
  "thesis",
  "webpage",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_FIELD_LENGTH) : undefined;
}

function names(value: unknown): CslName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CslName[] = [];
  for (const entry of value.slice(0, MAX_NAMES)) {
    if (!isRecord(entry)) continue;
    const family = text(entry.family);
    const given = text(entry.given);
    const literal = text(entry.literal);
    if (family) out.push({ family, ...(given ? { given } : {}) });
    else if (literal ?? given) out.push({ literal: (literal ?? given)! });
  }
  return out.length > 0 ? out : undefined;
}

function date(value: unknown): CslDate | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const year = /\b(\d{4})\b/.exec(String(value));
    return year ? { "date-parts": [[Number(year[1])]] } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const dateParts = value["date-parts"];
  if (Array.isArray(dateParts) && Array.isArray(dateParts[0])) {
    const first = dateParts[0].map(Number).filter((n) => Number.isInteger(n));
    if (first.length > 0 && first[0] > 0 && first[0] < 10_000) return { "date-parts": [first.slice(0, 3)] };
  }
  return date(value.literal ?? value.raw);
}

const TEXT_FIELDS = [
  "title",
  "container-title",
  "collection-title",
  "publisher",
  "publisher-place",
  "volume",
  "issue",
  "page",
  "edition",
  "DOI",
  "ISBN",
  "URL",
  "abstract",
  "language",
  "note",
] as const;

/**
 * A CSL item from an untrusted value, or the reason it isn't one. Only the
 * fields named above are kept, each as a trimmed string of bounded length:
 * a record is stored as jsonb and shown on a public page, so it is built
 * field by field and never passed through.
 *
 * A title is the one thing every record must have: a reference with none
 * can't be listed, cited by name, or told from another.
 */
export function parseCslItem(raw: unknown): { ok: true; item: CslItem } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "A reference is an object of CSL-JSON fields." };
  if (JSON.stringify(raw).length > MAX_ITEM_LENGTH) return { ok: false, error: "That record is too large to be one reference." };
  const type = typeof raw.type === "string" && (CSL_TYPES as readonly string[]).includes(raw.type) ? raw.type : "document";
  const item: CslItem = { type };
  for (const field of TEXT_FIELDS) {
    const value = text(raw[field]);
    if (value !== undefined) item[field] = value;
  }
  // A page range is written with an en dash, as every label writes one.
  if (item.page) item.page = item.page.replace(/\s*-{1,2}\s*/g, "–");
  const author = names(raw.author);
  const editor = names(raw.editor);
  const issued = date(raw.issued);
  if (author) item.author = author;
  if (editor) item.editor = editor;
  if (issued) item.issued = issued;
  if (!item.title) return { ok: false, error: "A reference needs a title." };
  return { ok: true, item };
}

/** A stored record read back: a column is untrusted input whoever wrote it. Null for one that no longer parses. */
export function cslOf(raw: unknown): CslItem | null {
  const parsed = parseCslItem(raw);
  return parsed.ok ? parsed.item : null;
}

/** The people a label names: the authors, or the editors of a work that has none. */
export function creatorsOf(item: CslItem): CslName[] {
  return item.author?.length ? item.author : (item.editor ?? []);
}

/** A name as a label shows it: the family name, or the whole of a name that isn't split. */
export function shortName(name: CslName): string {
  return name.family ?? name.literal ?? "";
}

/** The year, or null for an undated work. */
export function yearOf(item: CslItem): number | null {
  const year = Number(item.issued?.["date-parts"]?.[0]?.[0]);
  return Number.isInteger(year) && year > 0 ? year : null;
}

/**
 * The names a short citation gives: one, "A and B", or "A et al." for three
 * or more. Empty for a work with no creator, which a label then names by its
 * title.
 */
export function citedNames(item: CslItem): string {
  const creators = creatorsOf(item).map(shortName).filter(Boolean);
  if (creators.length === 0) return "";
  if (creators.length === 1) return creators[0];
  if (creators.length === 2) return `${creators[0]} and ${creators[1]}`;
  return `${creators[0]} et al.`;
}

/**
 * The start of a key for a record that arrives without one: the first
 * creator's family name and the year, `radner2012`, as BibTeX keys are
 * conventionally made. A work with no creator is keyed by its title's first
 * word.
 */
export function keyBaseOf(item: CslItem): string {
  const first = creatorsOf(item)[0];
  const who = slugify(first ? shortName(first) : (item.title ?? "").split(/\s+/)[0], "ref").replace(/-/g, "");
  return `${who || "ref"}${yearOf(item) ?? ""}`;
}

/** The shape of a library key: what Pandoc reads as a citation key, and a URL segment. */
export const REFERENCE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** A key as typed or imported, in the library's shape, or null when nothing of it survives. */
export function normalizeKey(raw: string): string | null {
  const key = slugify(raw, "").slice(0, 80).replace(/-+$/, "");
  return REFERENCE_KEY_RE.test(key) ? key : null;
}
