// docs/PDF_FRAGMENT_LINKS.md — a link to a passage of a PDF that is only a
// URL: `/pdf/<slug>#page=<n>&text=<passage>`, with no row anywhere.
//
// Pure and isomorphic, like src/lib/pdf-text.ts beside it: the viewer reads
// fragments with it, and the integrity check and the one-quote CLI write and
// verify them with it. So whatever the viewer finds, the check finds too.
//
// **The match is a skeleton** (§4): a passage matches the page text when
// their letters and digits agree, in order, after NFKD with combining marks
// dropped and case folded, and the match starts and ends on a word boundary
// of the page text. A PDF's extracted text breaks words apart ("bea tific"),
// runs them together ("ofAge") and keeps line-end hyphens, and a corrected
// copy or a model's quote differs from it in exactly the characters a
// skeleton drops. It is exact in every letter, so it is never fuzzy, and no
// step of `normalisePageText` changes a skeleton, so a NORMALISER_VERSION bump
// can't break a link.

/** At most this many passages are read from one URL (§3), so a pathological link can't make the viewer extract a hundred pages. */
export const MAX_FRAGMENT_PASSAGES = 8;

/** The writer's form (§8): a passage this many words long or shorter goes whole. */
export const WHOLE_PASSAGE_MAX_WORDS = 8;

/** The writer's form: a longer passage goes as this many words from each end, or more where needed. */
export const PASSAGE_END_WORDS = 3;

/** How many words of context the writer will add as a prefix before giving up on a repeated passage. */
const MAX_PREFIX_WORDS = 6;

/**
 * One passage of a fragment, decoded. The four text parts are free text:
 * only their letters and digits take part in a match, so a `+`, a `%20` or a
 * stray comma inside a quote makes no difference to what they find.
 */
export type FragmentPassage = {
  /** 1-based sheet number, exactly as `#page=` means it (src/lib/pdf-open-params.ts). */
  page: number;
  prefix: string | null;
  start: string;
  end: string | null;
  suffix: string | null;
};

/** The text half of a passage: what the matcher needs, without the page. */
export type PassageText = Omit<FragmentPassage, "page">;

/** A range in a page's normalised text, as `position` measures one: UTF-16 offsets, end exclusive. */
export type TextRange = { start: number; end: number };

/**
 * The passages a fragment names, in order. Parameters are read left to right,
 * as RFC 8118 reads a PDF's own: each `text` belongs to the nearest `page`
 * before it, a `text` with no valid `page` before it is ignored, and anything
 * else is ignored as `pageFromHash` ignores it. A passage whose grammar
 * doesn't parse, or one of whose parts has no letters or digits, is dropped
 * rather than guessed at.
 */
export function parseFragmentPassages(hash: string): FragmentPassage[] {
  const passages: FragmentPassage[] = [];
  let page: number | null = null;
  for (const param of hash.replace(/^#/, "").split("&")) {
    if (passages.length >= MAX_FRAGMENT_PASSAGES) break;
    const equals = param.indexOf("=");
    if (equals < 0) continue;
    const name = param.slice(0, equals);
    const value = param.slice(equals + 1);
    if (name === "page") {
      // An unreadable page forgets the one before it, so the texts after it
      // can't attach themselves to a page they were never written for.
      page = /^\d+$/.test(value) && Number(value) >= 1 ? Number(value) : null;
    } else if (name === "text" && page !== null) {
      const text = parsePassageText(value);
      if (text) passages.push({ page, ...text });
    }
  }
  return passages;
}

/**
 * Text Fragments' grammar, `[prefix-,]start[,end][,-suffix]`, over the raw
 * (still percent-encoded) value. The markers are read before decoding, as
 * Text Fragments reads them, so an encoded `%2C` or `%2D` is text, never
 * syntax.
 */
function parsePassageText(raw: string): PassageText | null {
  const tokens = raw.split(",");
  let prefix: string | null = null;
  let suffix: string | null = null;
  if (tokens.length > 1 && tokens[0].endsWith("-")) prefix = tokens.shift()!.slice(0, -1);
  if (tokens.length > 1 && tokens[tokens.length - 1].startsWith("-")) suffix = tokens.pop()!.slice(1);
  if (tokens.length < 1 || tokens.length > 2) return null;

  const parts = [prefix, tokens[0], tokens[1] ?? null, suffix].map((part) => (part === null ? null : decodePart(part)));
  // undefined is a part that didn't decode; "" is one with no letters or digits.
  if (parts.some((part) => part === undefined || part === "")) return null;
  const [decodedPrefix, start, end, decodedSuffix] = parts as (string | null)[];
  if (start === null) return null;
  return { prefix: decodedPrefix, start, end, suffix: decodedSuffix };
}

/** `+` is a word break, as a writer emits it. Undefined for a malformed escape; "" for a part with nothing to match. */
function decodePart(part: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
  return skeletonOf(decoded).text === "" ? "" : decoded.trim();
}

/**
 * The fragment for some passages, without its `#`: what a writer emits.
 * Every part becomes its words joined by `+`, so it needs no
 * percent-encoding except for letters with no ASCII base letter.
 */
export function formatFragmentPassages(passages: readonly FragmentPassage[]): string {
  return passages
    .map((passage) => {
      const parts = [
        passage.prefix !== null ? `${encodeWords(passage.prefix)}-` : null,
        encodeWords(passage.start),
        passage.end !== null ? encodeWords(passage.end) : null,
        passage.suffix !== null ? `-${encodeWords(passage.suffix)}` : null,
      ].filter((part): part is string => part !== null);
      return `page=${passage.page}&text=${parts.join(",")}`;
    })
    .join("&");
}

function encodeWords(text: string): string {
  return fragmentWords(text).map(encodeURIComponent).join("+");
}

// Combining marks, which NFKD splits off a letter; and what a skeleton keeps.
const MARK = /\p{M}/u;
const WORD = /[\p{L}\p{N}]/u;

/**
 * A text's words as a writer emits them: runs of letters and digits, accents
 * folded to their base letters, case as written. Everything else, including
 * an apostrophe or a hyphen inside a word, is a break between words.
 */
export function fragmentWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const ch of text) {
    for (const piece of ch.normalize("NFKD")) {
      if (MARK.test(piece)) continue;
      if (WORD.test(piece)) {
        word += piece;
      } else if (word) {
        words.push(word);
        word = "";
      }
    }
  }
  if (word) words.push(word);
  return words;
}

/**
 * A text's skeleton, with a map back to it: `starts[i]` and `ends[i]` are the
 * UTF-16 offsets of the character that produced `text[i]`. One character can
 * produce several (a ligature, or "²" from NFKD) or none.
 */
export type Skeleton = { text: string; starts: number[]; ends: number[] };

export function skeletonOf(source: string): Skeleton {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const ch of source) {
    const next = index + ch.length;
    for (const piece of ch.normalize("NFKD")) {
      if (MARK.test(piece)) continue;
      for (const lower of piece.toLowerCase()) {
        if (!WORD.test(lower)) continue;
        text += lower;
        starts.push(index);
        ends.push(next);
      }
    }
    index = next;
  }
  return { text, starts, ends };
}

/** Whether the character ending at `offset` or starting at it (by `side`) is part of a word. */
function wordCharAt(source: string, offset: number, side: "before" | "after"): boolean {
  if (side === "before") {
    if (offset <= 0) return false;
    let from = offset - 1;
    if (from > 0 && /[\uDC00-\uDFFF]/.test(source[from]) && /[\uD800-\uDBFF]/.test(source[from - 1])) from -= 1;
    return skeletonOf(source.slice(from, offset)).text !== "";
  }
  if (offset >= source.length) return false;
  const codePoint = String.fromCodePoint(source.codePointAt(offset)!);
  return skeletonOf(codePoint).text !== "";
}

/**
 * Every place `needle`'s skeleton occurs in the page, as skeleton indices,
 * where the occurrence begins and ends on a word boundary of the page text and
 * on whole characters of it (a match may not begin halfway through a
 * ligature's expansion).
 */
function occurrences(page: string, sk: Skeleton, needle: string, from = 0): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  for (let at = sk.text.indexOf(needle, from); at >= 0; at = sk.text.indexOf(needle, at + 1)) {
    const last = at + needle.length - 1;
    if (at > 0 && sk.starts[at - 1] === sk.starts[at]) continue;
    if (last + 1 < sk.text.length && sk.ends[last + 1] === sk.ends[last]) continue;
    if (wordCharAt(page, sk.starts[at], "before")) continue;
    if (wordCharAt(page, sk.ends[last], "after")) continue;
    found.push(at);
  }
  return found;
}

/**
 * Where a passage is on a page, as Text Fragments finds one: the first
 * occurrence of `start` that `prefix` immediately precedes, then (for a
 * range) the first `end` after it that `suffix` immediately follows. Null
 * when there is none.
 *
 * `prefix` and `suffix` are compared in skeleton space too, so whatever
 * punctuation or spacing stands between them and the passage is ignored.
 */
export function resolvePassage(page: string, passage: PassageText, sk: Skeleton = skeletonOf(page)): TextRange | null {
  const range = resolveAll(page, passage, sk, true)[0];
  return range ?? null;
}

/** How many places on the page a passage resolves to; more than one is the check's repeat warning (§8). */
export function countPassageOccurrences(page: string, passage: PassageText, sk: Skeleton = skeletonOf(page)): number {
  return resolveAll(page, passage, sk, false).length;
}

function resolveAll(page: string, passage: PassageText, sk: Skeleton, firstOnly: boolean): TextRange[] {
  const startKey = skeletonOf(passage.start).text;
  const endKey = passage.end !== null ? skeletonOf(passage.end).text : null;
  const prefixKey = passage.prefix !== null ? skeletonOf(passage.prefix).text : null;
  const suffixKey = passage.suffix !== null ? skeletonOf(passage.suffix).text : null;
  const results: TextRange[] = [];

  for (const at of occurrences(page, sk, startKey)) {
    // Occurrences are counted apart, never inside one another: a `start` that
    // recurs within the passage it begins ("to be able … then to be able also
    // … imagination") is the same passage, not a second one.
    const previous = results[results.length - 1];
    if (previous && sk.starts[at] < previous.end) continue;
    if (prefixKey !== null && !precededBy(page, sk, at, prefixKey)) continue;
    let last: number | null = null;
    if (endKey === null) {
      const candidate = at + startKey.length - 1;
      if (suffixKey === null || followedBy(page, sk, candidate, suffixKey)) last = candidate;
    } else {
      for (const endAt of occurrences(page, sk, endKey, at + startKey.length)) {
        const candidate = endAt + endKey.length - 1;
        if (suffixKey === null || followedBy(page, sk, candidate, suffixKey)) {
          last = candidate;
          break;
        }
      }
    }
    if (last === null) continue;
    results.push({ start: sk.starts[at], end: sk.ends[last] });
    if (firstOnly) break;
  }
  return results;
}

/** Whether `key`'s skeleton ends right before skeleton index `at`, and begins on a word boundary. */
function precededBy(page: string, sk: Skeleton, at: number, key: string): boolean {
  const from = at - key.length;
  if (from < 0 || sk.text.slice(from, at) !== key) return false;
  return !wordCharAt(page, sk.starts[from], "before");
}

/** Whether `key`'s skeleton starts right after skeleton index `last`, and ends on a word boundary. */
function followedBy(page: string, sk: Skeleton, last: number, key: string): boolean {
  const to = last + 1 + key.length;
  if (to > sk.text.length || sk.text.slice(last + 1, to) !== key) return false;
  return !wordCharAt(page, sk.ends[to - 1], "after");
}

/**
 * The writer's form of the passage at `range` on a page (§8): whole when it
 * is eight words or fewer, otherwise its first and last three words, each
 * extended a word at a time until the passage's first occurrence on the page
 * is this one. A prefix is added only when no length of either form can tell
 * two occurrences apart.
 *
 * `words` are the words to write, when the author's own (a corrected copy's
 * "imagination" for the page's "imagin ation") should stand in for the page's.
 * Their skeleton must be the passage's; every form is verified against the
 * page before it is returned, so a wrong one simply finds nothing. Null when
 * no form reaches this range.
 */
export function writerForm(page: string, range: TextRange, words?: readonly string[]): PassageText | null {
  const sk = skeletonOf(page);
  const passageWords = words ?? fragmentWords(page.slice(range.start, range.end));
  if (passageWords.length === 0) return null;

  const forms: { start: readonly string[]; end: readonly string[] | null }[] = [];
  if (passageWords.length <= WHOLE_PASSAGE_MAX_WORDS) {
    forms.push({ start: passageWords, end: null });
  } else {
    for (let k = PASSAGE_END_WORDS; 2 * k < passageWords.length; k++) {
      forms.push({ start: passageWords.slice(0, k), end: passageWords.slice(-k) });
    }
    forms.push({ start: passageWords, end: null });
  }

  const before = fragmentWords(page.slice(Math.max(0, range.start - 400), range.start));
  for (let prefixWords = 0; prefixWords <= Math.min(MAX_PREFIX_WORDS, before.length); prefixWords++) {
    const prefix = prefixWords > 0 ? before.slice(-prefixWords).join(" ") : null;
    for (const form of forms) {
      const candidate: PassageText = {
        prefix,
        start: form.start.join(" "),
        end: form.end ? form.end.join(" ") : null,
        suffix: null,
      };
      const found = resolvePassage(page, candidate, sk);
      if (found && found.start === range.start && found.end === range.end) return candidate;
    }
  }
  return null;
}

/**
 * A quote that runs across a page break, split where the break falls (§5).
 * Tries each word boundary in turn and keeps the split where the first part
 * matches whole on the first page and the rest whole on the next; a page's
 * folio and running head stand between the two, which is why one passage
 * can't hold both. The first part takes its *last* occurrence on its page,
 * the one nearest the break. Null when no split works.
 */
export function splitAcrossPages(
  firstPage: string,
  nextPage: string,
  quote: string,
): { first: TextRange; firstWords: string[]; next: TextRange; nextWords: string[] } | null {
  const words = fragmentWords(quote);
  const firstSk = skeletonOf(firstPage);
  const nextSk = skeletonOf(nextPage);
  for (let split = 1; split < words.length; split++) {
    const firstWords = words.slice(0, split);
    const nextWords = words.slice(split);
    const firsts = resolveAll(firstPage, { prefix: null, start: firstWords.join(" "), end: null, suffix: null }, firstSk, false);
    if (firsts.length === 0) continue;
    const next = resolvePassage(nextPage, { prefix: null, start: nextWords.join(" "), end: null, suffix: null }, nextSk);
    if (!next) continue;
    return { first: firsts[firsts.length - 1], firstWords, next, nextWords };
  }
  return null;
}
