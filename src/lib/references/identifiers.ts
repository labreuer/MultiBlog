
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

/**
 * Whether an ISBN identifies this record: one with no container whose type
 * isn't a part's by name. A chapter's or a conference paper's ISBN is its
 * book's, and `crossref` inheritance hands a paper its proceedings' ISBN, so
 * an `@inproceedings` with no `booktitle` would otherwise match a second
 * paper from the same proceedings.
 */
export function isbnIdentifies(record: { type: string; "container-title"?: unknown }): boolean {
  const container = record["container-title"];
  const hasContainer = typeof container === "string" ? container.trim() !== "" : typeof container === "object" && container !== null && Boolean((container as { text?: string }).text);
  return !hasContainer && !/^(chapter|paper-conference|article|entry|post|review)(-|$)/.test(record.type);
}

/** An ISBN as it is found in a field: its shape, so `9780631175049 (pbk.)` reads as one. */
const ISBN_SHAPE = /(?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx]\b/g;

/**
 * A field that can hold several identifiers: a hardback's and a paperback's,
 * however they were pasted. Each is found by its shape, so a note beside one,
 * `(pbk.)`, and two ISBN-10s with one space between them read as ISBNs; a
 * field with nothing of that shape is one identifier, to be checked and
 * refused.
 */
function parts(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const found = [...value.replace(/^\s*isbn(-1[03])?:?\s*/i, "").matchAll(ISBN_SHAPE)].map((match) => match[0].trim());
  return found.length > 0 ? found : [value.trim()];
}

/**
 * What a record is recognised by, and what it holds that isn't an
 * identifier at all.
 *
 * - Every ISBN on a book counts, so another format of the same edition is
 *   caught.
 * - **A chapter's ISBN is its book's**, so ISBNs are read only where they
 *   identify the record (`isbnIdentifies`): otherwise a second chapter of
 *   one anthology would read as a duplicate of the first. A chapter is
 *   matched by its DOI alone.
 */
export function identifiersOf(csl: { type: string; DOI?: unknown; ISBN?: unknown; "container-title"?: unknown; [field: string]: unknown }): { identifiers: Identifier[]; invalid: { scheme: IdentifierScheme; raw: string }[] } {
  const identifiers: Identifier[] = [];
  const invalid: { scheme: IdentifierScheme; raw: string }[] = [];
  const add = (scheme: IdentifierScheme, raw: string, value: string | null) => {
    if (value === null) invalid.push({ scheme, raw });
    else if (!identifiers.some((other) => other.scheme === scheme && other.value === value)) identifiers.push({ scheme, value });
  };
  if (typeof csl.DOI === "string" && csl.DOI.trim()) add("DOI", csl.DOI, normalizeDoi(csl.DOI));
  if (isbnIdentifies(csl)) {
    for (const raw of parts(csl.ISBN)) add("ISBN", raw, normalizeIsbn(raw));
  }
  return { identifiers, invalid };
}

/**
 * The record with each identifier that fails its check taken out, and which
 * (docs/CITATIONS.md, "The import box"): an import keeps the record, since
 * kept without it a record still has its other identifier to catch a later
 * copy by, and the preview says which, to be corrected first. An ISBN field
 * keeps the ISBNs that pass. `create_ref` refuses instead, since an agent can
 * correct it.
 */
export function withoutFailedIdentifiers<T extends { type: string; DOI?: unknown; ISBN?: unknown; "container-title"?: unknown }>(
  record: T,
): { data: T; dropped: { scheme: IdentifierScheme; raw: string }[] } {
  const { invalid } = identifiersOf(record);
  if (invalid.length === 0) return { data: record, dropped: [] };
  const out: T = { ...record };
  if (invalid.some((id) => id.scheme === "DOI")) delete out.DOI;
  if (invalid.some((id) => id.scheme === "ISBN")) {
    const kept = identifiersOf({ type: record.type, ISBN: record.ISBN }).identifiers.filter((id) => id.scheme === "ISBN");
    if (kept.length > 0) out.ISBN = kept.map((id) => id.value).join(", ");
    else delete out.ISBN;
  }
  return { data: out, dropped: invalid };
}
