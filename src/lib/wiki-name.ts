// docs/WIKI.md "What a name may hold" — a wiki page's name, which is its
// title, written as people write one: `Mercury (planet)`. MediaWiki's title
// rules (TitleParser::splitTitleString and $wgLegalTitleChars), changed where
// the doc says: the order of normalizing, seven refusals MediaWiki doesn't
// make, and case, which this module never touches (names compare by a key the
// database folds, "Case"; nothing folds in TypeScript).
//
// A name is normalized, then checked; the check refuses, with a message, and
// never repairs. Pure and browser-safe: a dialog checks a name with it as it
// is typed, and the server checks it again before asking the database for
// the name's key and whether every code point is assigned, which only the
// database can answer (its Unicode is the one the key is folded by). The
// doc_wiki_name_valid CHECK holds stored names to the same rules.
// wiki-name.test.ts is the table of what is accepted, normalized and refused.

/** MediaWiki's limit, in bytes of UTF-8: it bounds the URL and the index entry. */
export const WIKI_NAME_MAX_BYTES = 255;

/** Bidi marks, which arrive with pasted text: U+200E, U+200F and U+202A–U+202E. */
const BIDI_MARKS = /[\u200E\u200F\u202A-\u202E]/g;

/** What folds to one space: `_`, a space, and the Unicode space characters MediaWiki folds. */
const SPACES = /[_ \u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/**
 * A name as it is stored, before it is checked: bidi marks stripped, spaces
 * folded and trimmed, then NFC. NFC comes last, where MediaWiki puts it
 * first: a bidi mark is a starter, which NFC can't compose across, so
 * stripping one afterwards could leave a letter beside its combining mark.
 */
export function normalizeWikiName(input: string): string {
  return input.replace(BIDI_MARKS, "").replace(SPACES, " ").trim().normalize("NFC");
}

export type WikiNameCheck = { ok: true; name: string } | { ok: false; message: string };

/** A lone surrogate, which a JavaScript string can hold and encodeURIComponent throws on. */
const LONE_SURROGATE = /\p{Cs}/u;
const CONTROL = /[\u0000-\u001F\u007F]/;
/** MediaWiki's set leaves these out; `#` starts a fragment, and `[`, `]` and `|` write a link between pages. */
const OUTSIDE_SET = /[#<>[\]{}|]/;
const ENCODED = /%[0-9A-Fa-f]{2}/;
/** MediaWiki's `&[A-Za-z0-9\x80-\xff]+;`, which runs over bytes, so any non-ASCII character matches. */
const ENTITY = /&[A-Za-z0-9\u0080-\u{10FFFF}]+;/u;

/** The four characters refused here and allowed by MediaWiki, each with why. */
const REFUSED_HERE: Record<string, string> = {
  "/": "A name can't hold \"/\", which would split its URL in two.",
  "\\": "A name can't hold \"\\\", which a browser reads as \"/\".",
  "?": "A name can't hold \"?\", which would start its URL's query string.",
  "~": "A name can't hold \"~\", which separates a name from its variant.",
};

/** Whether every ")" closes a "(" before it and every "(" is closed. */
function parensBalanced(name: string): boolean {
  let depth = 0;
  for (const ch of name) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Normalizes `input` and checks the result by every rule but one: whether
 * each code point is assigned, which the database answers when the server
 * folds the name ("Case"). Returns the name as it would be stored, or the
 * first rule it breaks.
 */
export function checkWikiName(input: string): WikiNameCheck {
  const name = normalizeWikiName(input);
  const refuse = (message: string): WikiNameCheck => ({ ok: false, message });

  if (name === "") return refuse("A name can't be empty.");
  if (LONE_SURROGATE.test(name) || name.includes("\uFFFD")) {
    return refuse("A name can't hold a broken character, such as a lone surrogate or U+FFFD.");
  }
  if (CONTROL.test(name)) return refuse("A name can't hold a control character.");
  const outside = name.match(OUTSIDE_SET);
  if (outside) return refuse(`A name can't hold "${outside[0]}".`);
  for (const ch of name) {
    if (ch in REFUSED_HERE) return refuse(REFUSED_HERE[ch]);
  }
  if (ENCODED.test(name)) {
    return refuse("A name can't hold \"%\" followed by two hex digits, which reads as already encoded.");
  }
  if (ENTITY.test(name)) return refuse("A name can't hold an HTML entity, such as \"&amp;\".");
  if (name === "." || name === "..") return refuse(`A name can't be "${name}".`);
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > WIKI_NAME_MAX_BYTES) {
    return refuse(`A name can be at most ${WIKI_NAME_MAX_BYTES} bytes long; this one is ${bytes}.`);
  }
  if (!parensBalanced(name)) {
    return refuse("A name's parentheses must be balanced: each \")\" closing a \"(\" before it.");
  }
  if (/\.rsc$/i.test(name)) return refuse("A name can't end in \".rsc\".");
  return { ok: true, name };
}
