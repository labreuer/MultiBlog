// docs/CITATIONS.md, "Markdown" — a citation in Pandoc's syntax, both ways:
// the reading half the chip parse's tokenizer calls (markdown-import.ts), and
// the escapes the writer needs so that nothing reads back as a citation that
// wasn't one. Browser-safe and dependency-free.
//
//   [see @radner2012, p. 49; @barfield1957]   several works, with a prefix
//   [-@radner2012]                            the author suppressed
//   @radner2012 [p. 49]                       the narrative form
//   @radner2012                               the narrative form, bare
//   @{radner2012}                             the same key, braced
//
// What a citation names is a key, never an id: the parse yields keys, and
// the caller resolves each to a reference or refuses (parsed-chips.ts).

/** One work as the Markdown wrote it. */
export type MarkdownCitationItem = {
  key: string;
  prefix?: string;
  /** Everything after the key: the locator and the suffix, as the kind's validation splits them. */
  suffix?: string;
  suppressAuthor?: boolean;
};

export type MarkdownCitation = {
  /** The source it was read from, which the tokenizer consumes. */
  raw: string;
  items: MarkdownCitationItem[];
  narrative: boolean;
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const KEY_START = /[\p{L}\p{N}_]/u;

// Pandoc's key: a letter, digit or `_`, then those and internal punctuation,
// a punctuation character counting only when a key character follows it. So
// `@radner2012.` ends a sentence, and `@radner2012-style` is one key.
const BARE_KEY = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*/u;
// Braced, a key is whatever the braces hold.
const BRACED_KEY = /^\{([^{}\n]{1,200})\}/;

// A backslash escape, as CommonMark reads one: any ASCII punctuation.
const ESCAPED = /\\([!-/:-@[-`{-~])/g;

const unescape = (text: string) => text.replace(ESCAPED, "$1");

/** The key at the start of `src` (just after its `@`), and how much of `src` it took. */
function readKey(src: string): { key: string; length: number; braced: boolean } | null {
  const braced = BRACED_KEY.exec(src);
  if (braced) {
    const key = braced[1].trim();
    return key ? { key, length: braced[0].length, braced: true } : null;
  }
  const bare = BARE_KEY.exec(src);
  return bare ? { key: bare[0], length: bare[0].length, braced: false } : null;
}

/**
 * The index of the `]` closing the bracket `src` opens with, or -1. A
 * backslash escapes the character after it; an unescaped `[` inside, or a
 * blank line, means this isn't a citation.
 */
function closingBracket(src: string): number {
  for (let i = 1; i < src.length; i++) {
    const char = src[i];
    if (char === "\\") i += 1;
    else if (char === "]") return i;
    else if (char === "[") return -1;
    else if (char === "\n" && /^\n[ \t]*\n/.test(src.slice(i))) return -1;
  }
  return -1;
}

/** `text` split at each unescaped `;`. */
function splitItems(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === ";") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Whitespace folded, ends trimmed, escapes undone; absent when nothing is left. */
function field(text: string): string | undefined {
  const value = unescape(text).replace(/\s+/g, " ").trim();
  return value || undefined;
}

/**
 * One `;`-separated part of a bracketed citation: `see -@key, p. 49`. Its key
 * is the first unescaped `@` that starts a part or follows whitespace, alone
 * or after a `-` that does. Null when there is none.
 */
function readItem(part: string): MarkdownCitationItem | null {
  for (let i = 0; i < part.length; i++) {
    if (part[i] === "\\") {
      i += 1;
      continue;
    }
    if (part[i] !== "@") continue;
    const dashed = part[i - 1] === "-";
    const before = dashed ? part[i - 2] : part[i - 1];
    if (before !== undefined && !/\s/.test(before)) continue;
    const key = readKey(part.slice(i + 1));
    if (!key) continue;
    const prefix = field(part.slice(0, dashed ? i - 1 : i));
    const suffix = field(part.slice(i + 1 + key.length).replace(/^\s*,/, ""));
    return { key: key.key, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}), ...(dashed ? { suppressAuthor: true } : {}) };
  }
  return null;
}

/**
 * The citation `src` opens with, or null. `before` is the character in front
 * of it, if any: a bare `@` straight after a letter or digit isn't one, as in
 * `luke@example.com`, though a braced key is read wherever it stands.
 *
 * A bracket is a citation when every `;`-separated part of it names a key,
 * and not when a `(` follows it, which makes it a link's text: a mention,
 * `[@Name](/authors/<slug>)`, is claimed before any citation.
 */
export function readCitation(src: string, before: string | undefined): MarkdownCitation | null {
  if (src[0] === "[") {
    const end = closingBracket(src);
    if (end < 0 || src[end + 1] === "(") return null;
    const items = splitItems(src.slice(1, end)).map(readItem);
    if (items.length === 0 || items.some((item) => item === null)) return null;
    return { raw: src.slice(0, end + 1), items: items as MarkdownCitationItem[], narrative: false };
  }
  if (src[0] !== "@") return null;
  const key = readKey(src.slice(1));
  if (!key) return null;
  if (!key.braced && before !== undefined && LETTER_OR_DIGIT.test(before)) return null;
  let raw = src.slice(0, 1 + key.length);
  let suffix: string | undefined;
  // `@key [p. 49]`: the rest of a narrative citation, in a bracket of its own with no key in it.
  const rest = src.slice(raw.length);
  if (rest.startsWith(" [")) {
    const end = closingBracket(rest.slice(1));
    const inner = end < 0 ? "" : rest.slice(2, end + 1);
    if (end >= 0 && rest[end + 2] !== "(" && !/(^|[^\\])@/.test(inner)) {
      suffix = field(inner);
      raw += rest.slice(0, end + 2);
    }
  }
  return { raw, items: [{ key: key.key, ...(suffix ? { suffix } : {}) }], narrative: true };
}

/**
 * Where a citation might start in `src`: the parse's hint to marked, which
 * ends a run of text there. Not at an `@` after a letter or digit, which
 * can't start one unless braced: a run cut there would hide an address from
 * GFM's autolink, which looks ahead for the `@`.
 */
export function citationStart(src: string): number {
  return src.search(/\[|(?<![\p{L}\p{N}])@|@\{/u);
}

// --- Writing ----------------------------------------------------------------

/** `@key`, braced when the bare form would read back as some other key: `@{radner-}`. */
export function writeKey(key: string, braced = false): string {
  return braced || BARE_KEY.exec(key)?.[0] !== key ? `@{${key}}` : `@${key}`;
}

/** A prefix, locator or suffix inside a citation, its delimiters escaped. */
export function escapeCitationField(text: string): string {
  return text.replace(/[\\[\];@]/g, "\\$&");
}

/**
 * A chip's Markdown that opens with a bare `@key`, braced where it stands
 * needs it: after a letter or digit the `@` would read as text, and with key
 * characters after it, `@radner2012-style`, the key as a longer one. `before`
 * is the character in front of the chip, `after` the text behind it. Any
 * other Markdown is returned as it is.
 */
export function guardBareKey(md: string, before: string | undefined, after: string): string {
  if (!md.startsWith("@") || md.startsWith("@{")) return md;
  const key = BARE_KEY.exec(md.slice(1))?.[0];
  if (!key) return md;
  const rest = md.slice(1 + key.length);
  const behind = rest === "" ? after : rest;
  const needs = (before !== undefined && LETTER_OR_DIGIT.test(before)) || (BARE_KEY.exec(key + behind)?.[0].length ?? 0) > key.length;
  return needs ? `@{${key}}${rest}` : md;
}

/**
 * The offsets of the `@`s in `text` that would read back as a citation and so
 * are written `\@`: one before a key, unless a letter or digit precedes it,
 * and any before a brace. At the start of `text` nothing is known to precede
 * it, so it counts.
 */
export function citationShapedAts(text: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    const next = text[i + 1] ?? "";
    if (next === "{" || (KEY_START.test(next) && !(i > 0 && LETTER_OR_DIGIT.test(text[i - 1])))) at.push(i);
  }
  return at;
}
