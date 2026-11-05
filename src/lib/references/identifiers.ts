import type { CslItem } from "./csl";

// docs/CITATIONS.md, "Duplicates are caught by DOI and ISBN" — the two
// identifiers a reference is recognised by, each in the one form the
// `reference_identifier` table stores, so two spellings of one identifier
// are one row.
//
// Pure: no Prisma. An identifier that fails its check is refused by whoever
// calls this, never stored.

export type IdentifierScheme = "DOI" | "ISBN";
export type Identifier = { scheme: IdentifierScheme; value: string };

/**
 * A DOI in its stored form: the resolver prefix or `doi:` removed, and
 * lowercased, since DOIs are case-insensitive. Null for anything that isn't
 * one: a DOI is `10.`, a registrant code of four or more digits, a slash and
 * a suffix.
 */
export function normalizeDoi(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(value) ? value : null;
}

function isbn13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/**
 * An ISBN in its stored form: hyphens and spaces removed, its check digit
 * verified, and an ISBN-10 converted to ISBN-13, so `0-631-17504-0` and
 * `978-0-631-17504-9` are one book. Null for one that fails its check.
 */
export function normalizeIsbn(raw: string): string | null {
  const value = raw.replace(/^isbn(-1[03])?:?\s*/i, "").replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(value)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (value[i] === "X" ? 10 : Number(value[i])) * (10 - i);
    if (sum % 11 !== 0) return null;
    const first12 = `978${value.slice(0, 9)}`;
    return `${first12}${isbn13CheckDigit(first12)}`;
  }
  if (/^\d{13}$/.test(value)) {
    return isbn13CheckDigit(value.slice(0, 12)) === Number(value[12]) ? value : null;
  }
  return null;
}

/** CSL types that are a whole book: the only ones an ISBN identifies. */
const WHOLE_BOOK_TYPES = new Set(["book", "collection", "report", "thesis"]);

/** A field that can hold several identifiers: a hardback's and a paperback's, however they were pasted. */
function parts(value: unknown): string[] {
  return typeof value === "string"
    ? value
        .split(/[,;]|\s+(?=97[89])|\s{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

/**
 * What a record is recognised by, and what it holds that isn't an
 * identifier at all.
 *
 * - Every ISBN on a book counts, so another format of the same edition is
 *   caught.
 * - **A chapter's ISBN is its book's**, so ISBNs are read only for whole
 *   books: otherwise a second chapter of one anthology would read as a
 *   duplicate of the first. A chapter is matched by its DOI alone.
 */
export function identifiersOf(csl: CslItem): { identifiers: Identifier[]; invalid: { scheme: IdentifierScheme; raw: string }[] } {
  const identifiers: Identifier[] = [];
  const invalid: { scheme: IdentifierScheme; raw: string }[] = [];
  const add = (scheme: IdentifierScheme, raw: string, value: string | null) => {
    if (value === null) invalid.push({ scheme, raw });
    else if (!identifiers.some((other) => other.scheme === scheme && other.value === value)) identifiers.push({ scheme, value });
  };
  if (typeof csl.DOI === "string" && csl.DOI.trim()) add("DOI", csl.DOI, normalizeDoi(csl.DOI));
  if (WHOLE_BOOK_TYPES.has(csl.type)) {
    for (const raw of parts(csl.ISBN)) add("ISBN", raw, normalizeIsbn(raw));
  }
  return { identifiers, invalid };
}
