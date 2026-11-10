// docs/CITATIONS.md, "Keys" — what a library key may be, and the one rule
// that makes a lookup by key ignore case.
//
// Pure and browser-safe.

const MAX_KEY_LENGTH = 80;

/**
 * A library key: ASCII letters of either case, digits and `_`, with `:`, `.`
 * or `-` between them, at most 80 characters. Inside Pandoc's key grammar,
 * BibTeX's and a URL segment's, so `Frank_1970`, `radnerOriginIdeas2012`
 * and `smith.jones-2012` are all keys as given.
 */
export const LIBRARY_KEY_RE = /^[A-Za-z0-9_]+(?:[:.-][A-Za-z0-9_]+)*$/;

export function isLibraryKey(key: string): boolean {
  return key.length <= MAX_KEY_LENGTH && LIBRARY_KEY_RE.test(key);
}

/**
 * What may be looked up as a key: any library key, and any source key kept
 * as an alias (`reference_key_history`), which may hold what a library key
 * may not, such as dblp's `/` or an accented letter. Nothing with white
 * space or a brace, which no citation can write, and nothing longer than an
 * alias is kept at. The shape check a page runs before its first query.
 */
export const KEY_SHAPE_RE = /^[^\s{}]{1,200}$/;
export function isKeyShaped(key: string): boolean {
  return KEY_SHAPE_RE.test(key);
}

/**
 * A key as every lookup compares it, and as `key_folded` holds it: its ASCII
 * capitals lowercased and nothing else, the same rule as the column's CHECK
 * (`translate`). An alias's other letters match in their own case, since
 * `toLowerCase()` and Postgres's `lower()` disagree on some of them.
 */
export function foldKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** A key as asked for, in the form it is looked up in: composed (NFC), so one accented letter is one spelling, and folded. */
export function lookupKey(key: string): string {
  return foldKey(key.normalize("NFC"));
}

/** A reference's page. A key may hold `:`, which a link writes percent-encoded. */
export function referencePath(key: string): string {
  return `/references/${encodeURIComponent(key)}`;
}
