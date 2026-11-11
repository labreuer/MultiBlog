// docs/PDF_FRAGMENT_LINKS.md — a link to a passage of a PDF that is only a
// URL: `/pdf/<slug>#page=<n>&text=<passage>`, or `#p=<label>&text=<passage>`
// by the page printed on it, with no row anywhere.

import { formatPageName, isPageParam, pageNameOf, type PageName } from "./pdf-open-params";
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
 * One passage of a fragment, decoded. Its text parts are free text: only
 * their letters and digits take part in a match, so a `+`, a `%20` or a stray
 * comma inside a quote makes no difference to what they find.
 */
export type FragmentPassage = PassageText & {
  /**
   * The page it names: a 1-based sheet, exactly as `#page=` means it, or a
   * printed label, as `#p=` gives one (src/lib/pdf-open-params.ts). Only
   * `sheetsNamed` (src/lib/pdf-page-labels.ts) turns a label into sheets.
   */
  page: PageName;
};

/**
 * One run of quoted words: whole, or by its first and last words
 * (`start,end`), when nothing between them is matched.
 */
export type PassageSegment = { start: string; end: string | null };

/**
 * The text half of a passage: what the matcher needs, without the page.
 *
 * `segments` are the runs a quoter kept, in order, at least one, joined by
 * `...` in a URL (§2). Words between two segments were left out, and there
 * may be none at all. `prefix` comes right before the first segment and
 * `suffix` right after the last.
 */
export type PassageText = {
  prefix: string | null;
  segments: readonly PassageSegment[];
  suffix: string | null;
};

/** A passage of one segment: a quote with nothing left out, or its two ends. */
export function onePassage(
  start: string,
  opts: { end?: string | null; prefix?: string | null; suffix?: string | null } = {},
): PassageText {
  return { prefix: opts.prefix ?? null, segments: [{ start, end: opts.end ?? null }], suffix: opts.suffix ?? null };
}

/** A range in a page's normalised text, as `position` measures one: UTF-16 offsets, end exclusive. */
export type TextRange = { start: number; end: number };

/**
 * The passages a fragment names, in order. Parameters are read left to right,
 * as RFC 8118 reads a PDF's own: each `text` belongs to the nearest `page` or
 * `p` before it, a `text` with no valid page before it is ignored, and
 * anything else is ignored as `pageFromHash` ignores it. A passage whose
 * grammar doesn't parse, or one of whose parts has no letters or digits, is
 * dropped rather than guessed at.
 */
export function parseFragmentPassages(hash: string): FragmentPassage[] {
  const passages: FragmentPassage[] = [];
  let page: PageName | null = null;
  for (const param of hash.replace(/^#/, "").split("&")) {
    if (passages.length >= MAX_FRAGMENT_PASSAGES) break;
    const equals = param.indexOf("=");
    if (equals < 0) continue;
    const name = param.slice(0, equals);
    const value = param.slice(equals + 1);
    if (isPageParam(name)) {
      // An unreadable page forgets the one before it, so the texts after it
      // can't attach themselves to a page they were never written for.
      page = pageNameOf(name, value);
    } else if (name === "text" && page !== null) {
      const text = parsePassageText(value);
      if (text) passages.push({ page, ...text });
    }
  }
  return passages;
}

// The separator between a passage's segments (§2): exactly three dots, or
// `…` as the character or as `location.hash` holds one. It is read before
// decoding, as `,` and `-` are, but `…` is the one marker read encoded too.
const ELLIPSIS = /\.\.\.|…|%E2%80%A6/gi;

/**
 * Text Fragments' grammar, `[prefix-,]start[,end][,-suffix]`, over the raw
 * (still percent-encoded) value, with `...` between segments (§2). The value
 * splits on `...` first; a prefix belongs to the first segment and a suffix
 * to the last, and each segment may be shortened to its ends with `,`. The
 * `,` and `-` markers are read before decoding, as Text Fragments reads
 * them, so an encoded `%2C` or `%2D` is text, never syntax. A segment with no
 * letters or digits, as an ellipsis at either end leaves, is dropped.
 */
export function parsePassageText(raw: string): PassageText | null {
  const pieces = raw.split(ELLIPSIS).map((piece) => piece.split(","));
  let prefix: string | null = null;
  let suffix: string | null = null;
  const first = pieces[0];
  if (first.length > 1 && first[0].endsWith("-")) prefix = first.shift()!.slice(0, -1);
  const last = pieces[pieces.length - 1];
  if (last.length > 1 && last[last.length - 1].startsWith("-")) suffix = last.pop()!.slice(1);

  const segments: PassageSegment[] = [];
  for (const [index, tokens] of pieces.entries()) {
    if (tokens.length > 2) return null;
    // A prefix or a suffix anywhere but the passage's own ends is no passage.
    if (tokens.length === 2 && ((index > 0 && tokens[0].endsWith("-")) || (index < pieces.length - 1 && tokens[1].startsWith("-")))) return null;
    const start = decodePart(tokens[0]);
    const end = tokens.length === 2 ? decodePart(tokens[1]) : null;
    if (start === undefined || end === undefined) return null;
    if (end === null) {
      // Nothing to match: an ellipsis at an end, or two in a row.
      if (start !== "") segments.push({ start, end: null });
    } else {
      if (start === "" || end === "") return null;
      segments.push({ start, end });
    }
  }
  if (segments.length === 0) return null;
  const [decodedPrefix, decodedSuffix] = [prefix, suffix].map((part) => (part === null ? null : decodePart(part)));
  if (decodedPrefix === undefined || decodedPrefix === "" || decodedSuffix === undefined || decodedSuffix === "") return null;
  return { prefix: decodedPrefix, segments, suffix: decodedSuffix };
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
  return passages.map((passage) => `${formatPageName(passage.page)}&text=${formatPassageText(passage)}`).join("&");
}

/** One passage's `text` value: its segments joined by `...`, a prefix before the first and a suffix after the last. */
export function formatPassageText(passage: PassageText): string {
  const segments = passage.segments
    .map((segment) => (segment.end !== null ? `${encodeWords(segment.start)},${encodeWords(segment.end)}` : encodeWords(segment.start)))
    .join("...");
  return [
    passage.prefix !== null ? `${encodeWords(passage.prefix)}-` : null,
    segments,
    passage.suffix !== null ? `-${encodeWords(passage.suffix)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(",");
}

/**
 * A passage's words as an answer names them: `start` and `end` for a passage
 * of one segment, as before there were others, and `segments` for one with
 * words left out.
 */
export function passageWords(passage: PassageText): { start: string; end?: string } | { segments: { start: string; end?: string }[] } {
  const shown = passage.segments.map((segment) => ({ start: segment.start, ...(segment.end !== null ? { end: segment.end } : {}) }));
  return shown.length === 1 ? shown[0] : { segments: shown };
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
 * Every place `needle`'s skeleton occurs in the page from skeleton index
 * `from`, in order, as skeleton indices, where the occurrence begins and ends
 * on a word boundary of the page text and on whole characters of it (a match
 * may not begin halfway through a ligature's expansion).
 */
function* occurrences(page: string, sk: Skeleton, needle: string, from = 0): Generator<number> {
  if (needle === "") return;
  for (let at = sk.text.indexOf(needle, from); at >= 0; at = sk.text.indexOf(needle, at + 1)) {
    const last = at + needle.length - 1;
    if (at > 0 && sk.starts[at - 1] === sk.starts[at]) continue;
    if (last + 1 < sk.text.length && sk.ends[last + 1] === sk.ends[last]) continue;
    if (wordCharAt(page, sk.starts[at], "before")) continue;
    if (wordCharAt(page, sk.ends[last], "after")) continue;
    yield at;
  }
}

/**
 * Where a passage is on a page, as Text Fragments finds one: the first
 * occurrence of its first segment's `start` that `prefix` immediately
 * precedes, then (for a range) the first `end` after it, then each later
 * segment the same way after the one before it, the last one followed by
 * `suffix`. The range runs from the first segment's start to the last
 * one's end, so the words left out between segments are inside it. Null
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

type SegmentKeys = { start: string; end: string | null };

/**
 * Every place on the page a passage resolves to, in page order, counted apart
 * (never one inside another) — or only the first, with `firstOnly`. What the
 * MCP server's quote locator uses for `ambiguous` and for `read`'s `around`
 * (docs/MCP.md §8), where `resolvePassage` above answers with the first.
 */
export function resolveAll(page: string, passage: PassageText, sk: Skeleton = skeletonOf(page), firstOnly = false): TextRange[] {
  const keys: SegmentKeys[] = passage.segments.map((segment) => ({
    start: skeletonOf(segment.start).text,
    end: segment.end !== null ? skeletonOf(segment.end).text : null,
  }));
  const prefixKey = passage.prefix !== null ? skeletonOf(passage.prefix).text : null;
  const suffixKey = passage.suffix !== null ? skeletonOf(passage.suffix).text : null;
  const results: TextRange[] = [];
  if (keys.length === 0) return results;

  for (const at of occurrences(page, sk, keys[0].start)) {
    // Occurrences are counted apart, never inside one another: a `start` that
    // recurs within the passage it begins ("to be able … then to be able also
    // … imagination") is the same passage, not a second one.
    const previous = results[results.length - 1];
    if (previous && sk.starts[at] < previous.end) continue;
    if (prefixKey !== null && !precededBy(page, sk, at, prefixKey)) continue;
    const last = passageEnd(page, sk, keys, at, suffixKey);
    if (last === null) continue;
    results.push({ start: sk.starts[at], end: sk.ends[last] });
    if (firstOnly) break;
  }
  return results;
}

/**
 * The skeleton index of the last character of the passage whose first
 * segment starts at `at`, or null. Each later segment is its first match
 * after the one before it ends (§2), which is never worse for the segments
 * after it than a later match would be. A gap may hold no words at all.
 * Only the last segment answers to `suffix`.
 */
function passageEnd(page: string, sk: Skeleton, keys: readonly SegmentKeys[], at: number, suffixKey: string | null): number | null {
  let last = segmentEnd(page, sk, keys[0], at, keys.length === 1 ? suffixKey : null);
  for (let i = 1; i < keys.length && last !== null; i++) {
    const segmentSuffix = i === keys.length - 1 ? suffixKey : null;
    let found: number | null = null;
    for (const next of occurrences(page, sk, keys[i].start, last + 1)) {
      found = segmentEnd(page, sk, keys[i], next, segmentSuffix);
      // Only a suffix can make a later start do better than the first.
      if (found !== null || segmentSuffix === null) break;
    }
    last = found;
  }
  return last;
}

/** Where one segment starting at `at` ends: its start's last character, or its `end`'s first match after it; null when there is none, or `suffix` doesn't follow. */
function segmentEnd(page: string, sk: Skeleton, key: SegmentKeys, at: number, suffixKey: string | null): number | null {
  if (key.end === null) {
    const candidate = at + key.start.length - 1;
    return suffixKey === null || followedBy(page, sk, candidate, suffixKey) ? candidate : null;
  }
  for (const endAt of occurrences(page, sk, key.end, at + key.start.length)) {
    const candidate = endAt + key.end.length - 1;
    if (suffixKey === null || followedBy(page, sk, candidate, suffixKey)) return candidate;
  }
  return null;
}

/**
 * Every place one segment matches on the page at or after text offset `from`,
 * in page order and counted apart, or only the first, with `firstOnly`: what
 * places a quotation's segments one after another across pages
 * (src/lib/pdf-passage-pieces.ts).
 */
export function segmentRanges(page: string, segment: PassageSegment, from = 0, sk: Skeleton = skeletonOf(page), firstOnly = false): TextRange[] {
  const key: SegmentKeys = { start: skeletonOf(segment.start).text, end: segment.end !== null ? skeletonOf(segment.end).text : null };
  // The first skeleton character at or after `from`.
  let low = 0;
  let high = sk.starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sk.starts[mid] < from) low = mid + 1;
    else high = mid;
  }
  const ranges: TextRange[] = [];
  for (const at of occurrences(page, sk, key.start, low)) {
    const previous = ranges[ranges.length - 1];
    if (previous && sk.starts[at] < previous.end) continue;
    const last = segmentEnd(page, sk, key, at, null);
    // No end after this start is none after a later one either.
    if (last === null) break;
    ranges.push({ start: sk.starts[at], end: sk.ends[last] });
    if (firstOnly) break;
  }
  return ranges;
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
  return segmentedWriterForm(page, range, [words ?? fragmentWords(page.slice(range.start, range.end))]);
}

/**
 * The writer's form of a passage with words left out (§2): each segment's
 * words, in order, the first segment's first word starting `range` and the
 * last segment's last word ending it. Each segment goes as `writerForm` takes
 * a passage, whole up to eight words and otherwise by its ends, every long
 * segment extended alike, and a prefix only where no length tells the
 * occurrences apart. Verified against the page, as `writerForm` is.
 */
export function segmentedWriterForm(page: string, range: TextRange, segments: readonly (readonly string[])[]): PassageText | null {
  if (segments.length === 0 || segments.some((words) => words.length === 0)) return null;
  const sk = skeletonOf(page);

  // One candidate per length of the shortened ends, every segment longer than
  // twice that shortened to it, then every segment whole.
  const forms: PassageSegment[][] = [];
  const longest = Math.max(...segments.map((words) => words.length));
  if (longest > WHOLE_PASSAGE_MAX_WORDS) {
    for (let k = PASSAGE_END_WORDS; 2 * k < longest; k++) {
      forms.push(
        segments.map((words) =>
          words.length > WHOLE_PASSAGE_MAX_WORDS && 2 * k < words.length
            ? { start: words.slice(0, k).join(" "), end: words.slice(-k).join(" ") }
            : { start: words.join(" "), end: null },
        ),
      );
    }
  }
  forms.push(segments.map((words) => ({ start: words.join(" "), end: null })));

  const before = fragmentWords(page.slice(Math.max(0, range.start - 400), range.start));
  for (let prefixWords = 0; prefixWords <= Math.min(MAX_PREFIX_WORDS, before.length); prefixWords++) {
    const prefix = prefixWords > 0 ? before.slice(-prefixWords).join(" ") : null;
    for (const form of forms) {
      const candidate: PassageText = { prefix, segments: form, suffix: null };
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
    const firsts = resolveAll(firstPage, onePassage(firstWords.join(" ")), firstSk, false);
    if (firsts.length === 0) continue;
    const next = resolvePassage(nextPage, onePassage(nextWords.join(" ")), nextSk);
    if (!next) continue;
    return { first: firsts[firsts.length - 1], firstWords, next, nextWords };
  }
  return null;
}
