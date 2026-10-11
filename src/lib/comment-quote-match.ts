import type { Node as PMNode } from "@tiptap/pm/model";

// PLAN.md §23n — the quote matcher, pure and browser-safe: given a comment
// body's quotations (typed as `> …` in the Markdown box, pasted as "…", or
// inserted by the rich composer's quote gesture) and the immutable targets
// on the page, find where each one came from.
//
// **The technique is the one docs/COLLAB.md §4 rejected**, and COLLAB.md §9
// says why it is safe here and was not there: flatten the target once with
// a position map, normalize both sides, search, map back — and then *verify
// every hit* against `textBetween` before anything is stored. A flattening
// mistake here costs a missed match and never a wrong anchor, because the
// stored text is derived from the verified range, not from the query.
//
// The unit table beside this file (comment-quote-match.test.ts) is the
// rejection surface — the cases that must match, and the ones that must not.

/** A normalized string plus, per normalized character, the index it came from. */
export type Normalized = { text: string; map: number[] };

/**
 * PLAN.md §23n's normalization, applied identically to both sides: NFKC,
 * curly quotes and apostrophes to straight, dashes to a hyphen, an ellipsis
 * to three dots, every whitespace run to one space, trimmed. Not
 * case-folded and not punctuation-stripped — copy-paste preserves both, and
 * folding widens false positives more than it recovers.
 *
 * `map[i]` is the index into `input` of the character normalized char `i`
 * came from, so a hit in the normalized text maps back to the original.
 */
export function normalizeForMatch(input: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let index = 0;
  let pendingSpace = false;
  for (const raw of input) {
    const originalIndex = index;
    index += raw.length;
    let chars: string;
    if (/\s/.test(raw) || raw === " ") {
      pendingSpace = out.length > 0;
      continue;
    }
    switch (raw) {
      case "‘":
      case "’":
      case "‚":
      case "′":
        chars = "'";
        break;
      case "“":
      case "”":
      case "„":
      case "″":
        chars = '"';
        break;
      case "‐":
      case "‑":
      case "‒":
      case "–":
      case "—":
      case "―":
      case "−":
        chars = "-";
        break;
      case "…":
        chars = "...";
        break;
      default:
        chars = raw.normalize("NFKC");
    }
    if (pendingSpace) {
      out.push(" ");
      map.push(originalIndex);
      pendingSpace = false;
    }
    for (const c of chars) {
      out.push(c);
      map.push(originalIndex);
    }
  }
  return { text: out.join(""), map };
}

/**
 * A target document flattened to one string, with each flat character's
 * ProseMirror position beside it.
 *
 * Text nodes contribute their characters at their positions; an inline leaf
 * (a hard break) and every textblock boundary contribute a newline, which
 * normalization then collapses to a space — so a quote of two consecutive
 * paragraphs typed as one `>` block, or as two, matches either way. This is
 * what `findQuoteOccurrences` cannot do (its `textBetween` window undercounts
 * a block boundary), and it is affordable because it runs once per candidate
 * per submission rather than per keystroke.
 */
export type FlatTarget = {
  node: PMNode;
  /** The normalized flat text. */
  text: string;
  /** Per normalized character, the ProseMirror position of the character it came from. */
  positions: number[];
};

export function flattenForMatch(node: PMNode): FlatTarget {
  const chars: string[] = [];
  const flatPositions: number[] = [];
  node.descendants((child, pos) => {
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i++) {
        chars.push(child.text[i]);
        flatPositions.push(pos + i);
      }
      return false;
    }
    if (child.isTextblock) {
      if (chars.length > 0) {
        chars.push("\n");
        flatPositions.push(pos);
      }
      return true;
    }
    if (child.isInline && child.isLeaf) {
      chars.push("\n");
      flatPositions.push(pos);
      return false;
    }
    return true;
  });
  const normalized = normalizeForMatch(chars.join(""));
  return {
    node,
    text: normalized.text,
    positions: normalized.map.map((flatIndex) => flatPositions[flatIndex]),
  };
}

export type QuoteRange = { from: number; to: number };

export type MatchTier = "hint" | "exact" | "ends";

export type QuoteMatch = QuoteRange & {
  tier: MatchTier;
  /** `quotedTextAt` the verified range — what is stored, never the query. */
  quotedText: string;
};

/**
 * The derivation every comment quote's `quoted_text` uses: `textBetween`
 * with a space for a block boundary, like every other anchor in the
 * codebase, and a space for an inline leaf too — a hard break inside the
 * quoted words would otherwise contribute nothing and glue two words
 * together. The integrity check and the rewrite (§23f) derive with this
 * same function, so the three copies agree by construction.
 */
export function quotedTextAt(node: PMNode, from: number, to: number): string {
  return node.textBetween(from, to, " ", " ");
}

/** The one-line rule for "is this range the query": normalized quotedTextAt equals normalized query. */
function verifyExact(target: FlatTarget, range: QuoteRange, normalizedQuery: string): QuoteMatch | null {
  const size = target.node.content.size;
  if (range.from < 0 || range.to > size || range.to <= range.from) return null;
  const quotedText = quotedTextAt(target.node, range.from, range.to);
  if (normalizeForMatch(quotedText).text !== normalizedQuery) return null;
  return { ...range, tier: "exact", quotedText };
}

/** A hit in the normalized flat text, [start, end), mapped back to ProseMirror positions. */
function rangeFromFlat(target: FlatTarget, start: number, end: number): QuoteRange {
  return { from: target.positions[start], to: target.positions[end - 1] + 1 };
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    found.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return found;
}

/**
 * PLAN.md §23n's ambiguity rule, within one target: several occurrences
 * pick the one nearest `near` if the caller has a position (the thread's
 * own passage anchor), else the first. A deliberate departure from
 * `resolveAnchorInDoc`'s exactly-one rule — identical text in one immutable
 * object is the same words by the same author, so the citation and the
 * stored text are right whichever twin is chosen.
 */
function pickNearest(target: FlatTarget, starts: number[], near: number | undefined): number {
  if (near === undefined || starts.length === 1) return starts[0];
  let best = starts[0];
  let bestDistance = Math.abs(target.positions[best] - near);
  for (const start of starts.slice(1)) {
    const distance = Math.abs(target.positions[start] - near);
    if (distance < bestDistance) {
      best = start;
      bestDistance = distance;
    }
  }
  return best;
}

/** How many normalized characters each end of a quote must match for the fuzzy tier. */
export const END_CHARS = 32;

/** The fuzzy tier's tolerance on the span between the matched ends, as a fraction of the query's length. */
const ENDS_LENGTH_TOLERANCE = 0.2;

/**
 * Where `query` sits in `target`, by the tiers §23n lists, or null.
 *
 * 1. `hint` — the client's own offsets, verified (the rich composer knows
 *    exactly what was selected; the Markdown box supplies nothing here).
 * 2. `exact` — the normalized query as a substring of the normalized target.
 * 3. `ends` — the first and last END_CHARS of the query both found, in
 *    order, with the span between within a fifth of the query's length:
 *    a typo or a dropped word in a hand-typed quote. Only for queries long
 *    enough to have two distinct ends; the rewrite then *corrects* the
 *    typo, which is what makes accepting it safe (§23f).
 *
 * `tiers` lets the caller run one tier across every candidate before the
 * next (exact in any candidate beats fuzzy in the first).
 */
export function findQuoteInTarget(
  target: FlatTarget,
  query: string,
  opts: { hint?: QuoteRange; near?: number; tiers?: MatchTier[] } = {},
): QuoteMatch | null {
  const normalizedQuery = normalizeForMatch(query).text;
  if (!normalizedQuery) return null;
  const tiers = opts.tiers ?? ["hint", "exact", "ends"];

  if (tiers.includes("hint") && opts.hint) {
    const hit = verifyExact(target, opts.hint, normalizedQuery);
    if (hit) return { ...hit, tier: "hint" };
  }

  if (tiers.includes("exact")) {
    const starts = allIndexesOf(target.text, normalizedQuery);
    if (starts.length > 0) {
      const start = pickNearest(target, starts, opts.near);
      const hit = verifyExact(target, rangeFromFlat(target, start, start + normalizedQuery.length), normalizedQuery);
      if (hit) return hit;
    }
  }

  if (tiers.includes("ends") && normalizedQuery.length >= END_CHARS * 2 + 1) {
    const head = normalizedQuery.slice(0, END_CHARS);
    const tail = normalizedQuery.slice(-END_CHARS);
    const minSpan = Math.floor(normalizedQuery.length * (1 - ENDS_LENGTH_TOLERANCE));
    const maxSpan = Math.ceil(normalizedQuery.length * (1 + ENDS_LENGTH_TOLERANCE));
    const candidates: number[] = [];
    const spans = new Map<number, number>();
    for (const start of allIndexesOf(target.text, head)) {
      const tailAt = target.text.indexOf(tail, start + END_CHARS);
      if (tailAt === -1) continue;
      const span = tailAt + END_CHARS - start;
      if (span < minSpan || span > maxSpan) continue;
      candidates.push(start);
      spans.set(start, span);
    }
    if (candidates.length > 0) {
      const start = pickNearest(target, candidates, opts.near);
      const range = rangeFromFlat(target, start, start + spans.get(start)!);
      // Verify what the tier claims — both ends — against textBetween, so a
      // flattening mistake at a boundary is a miss rather than a wrong anchor.
      const quotedText = quotedTextAt(target.node, range.from, range.to);
      const normalizedHit = normalizeForMatch(quotedText).text;
      if (normalizedHit.startsWith(head) && normalizedHit.endsWith(tail)) {
        return { ...range, tier: "ends", quotedText };
      }
    }
  }

  return null;
}

/** A candidate target, in priority order, with what the caller knows about it. */
export type QuoteCandidate<T> = {
  key: T;
  target: FlatTarget;
  /** The thread's own passage anchor when quoting the host post — the nearest-occurrence hint. */
  near?: number;
};

/**
 * The cross-candidate rule: each tier runs across every candidate in
 * priority order before the next tier starts, and a hinted candidate is
 * tried first within its tier. Returns the winning candidate's key with the
 * match.
 */
export function matchQuoteAcross<T>(
  candidates: QuoteCandidate<T>[],
  query: string,
  hint?: { key: T; range?: QuoteRange },
): { key: T; match: QuoteMatch } | null {
  const ordered = hint
    ? [...candidates.filter((c) => c.key === hint.key), ...candidates.filter((c) => c.key !== hint.key)]
    : candidates;
  if (hint?.range) {
    const hinted = ordered.find((c) => c.key === hint.key);
    if (hinted) {
      const match = findQuoteInTarget(hinted.target, query, { hint: hint.range, tiers: ["hint"] });
      if (match) return { key: hinted.key, match };
    }
  }
  for (const tier of ["exact", "ends"] as const) {
    for (const candidate of ordered) {
      const match = findQuoteInTarget(candidate.target, query, { near: candidate.near, tiers: [tier] });
      if (match) return { key: candidate.key, match };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// docs/MCP.md §7 — the entry points a machine client's anchoring needs, built
// from the pieces above. `findQuoteInTarget` answers with one hit at most: its
// exact tier takes the first or the nearest of several (`pickNearest`), and a
// comment can afford that, where an annotation's highlight cannot. So these
// answer with *every* occurrence, verified, and leave refusing an ambiguous
// one to the caller.
//
// **Only an exact match counts here.** The `ends` tier above accepts a long
// quote whose middle differs, and stores the real text in its place; for a
// write that would anchor a model's misremembering somewhere it didn't mean,
// so it only ever *suggests* (`nearMisses`).

/** Every occurrence of `query` in `target`, each verified against `textBetween`. */
export function findAllExact(target: FlatTarget, query: string): QuoteMatch[] {
  const normalizedQuery = normalizeForMatch(query).text;
  if (!normalizedQuery) return [];
  const found: QuoteMatch[] = [];
  for (const start of allIndexesOf(target.text, normalizedQuery)) {
    const hit = verifyExact(target, rangeFromFlat(target, start, start + normalizedQuery.length), normalizedQuery);
    if (hit && !found.some((other) => other.from === hit.from && other.to === hit.to)) found.push(hit);
  }
  return found;
}

/**
 * The matches whose neighbouring text agrees with a `prefix` before them or a
 * `suffix` after, under the same folding — the W3C TextQuoteSelector's
 * disambiguators. Compared in the flattened text, so a block boundary between
 * the prefix and the quote reads as the space it normalizes to.
 */
export function filterByContext(
  target: FlatTarget,
  matches: QuoteMatch[],
  context: { prefix?: string; suffix?: string },
): QuoteMatch[] {
  const prefix = context.prefix ? normalizeForMatch(context.prefix).text : "";
  const suffix = context.suffix ? normalizeForMatch(context.suffix).text : "";
  if (!prefix && !suffix) return matches;
  return matches.filter((match) => {
    const start = flatIndexOf(target, match.from);
    const end = flatIndexAfter(target, match.to);
    if (start === null || end === null) return false;
    if (prefix && !target.text.slice(0, start).trimEnd().endsWith(prefix)) return false;
    if (suffix && !target.text.slice(end).trimStart().startsWith(suffix)) return false;
    return true;
  });
}

/** The flat index of the first character at or after position `pos`. */
function flatIndexOf(target: FlatTarget, pos: number): number | null {
  const index = target.positions.findIndex((p) => p >= pos);
  return index === -1 ? null : index;
}

/** The flat index just past the last character before position `pos`. */
function flatIndexAfter(target: FlatTarget, pos: number): number | null {
  for (let i = target.positions.length - 1; i >= 0; i--) {
    if (target.positions[i] < pos) return i + 1;
  }
  return null;
}

/**
 * A passage named by its ends (docs/MCP.md §7): from each occurrence of
 * `start` to the end of the first occurrence of `end` after it, verified like
 * any other hit — its folded text must begin with `start` and end with `end`.
 * The words between are not checked here, since they weren't sent: an anchor
 * derives its stored quote from the document, and an edit checks them against
 * the version it was read at (§6).
 */
export function findByEnds(target: FlatTarget, start: string, end: string): QuoteMatch[] {
  const head = normalizeForMatch(start).text;
  const tail = normalizeForMatch(end).text;
  if (!head || !tail) return [];
  const found: QuoteMatch[] = [];
  for (const at of allIndexesOf(target.text, head)) {
    const tailAt = target.text.indexOf(tail, at + head.length);
    if (tailAt === -1) continue;
    const range = rangeFromFlat(target, at, tailAt + tail.length);
    const quotedText = quotedTextAt(target.node, range.from, range.to);
    const normalized = normalizeForMatch(quotedText).text;
    if (!normalized.startsWith(head) || !normalized.endsWith(tail)) continue;
    // A later `start` inside a passage already found is the same passage.
    if (found.some((other) => other.from <= range.from && range.from < other.to)) continue;
    found.push({ ...range, tier: "exact", quotedText });
  }
  return found;
}

/** A suggestion for a quote that matched nowhere: where something like it is, and what it says there. */
export type NearMiss = QuoteRange & { quotedText: string };

/** The `ends` tier suggests only for a quote this long once normalized. */
export const NEAR_MISS_ENDS_MIN = 65;

/**
 * Up to `limit` places where something like `query` is, for a `no_match`
 * answer — never an anchor. Two sources: the `ends` tier above, for a long
 * quote whose first and last 32 characters are right; and, since a shorter
 * quote or one wrong anywhere in either end gets nothing from that, the
 * windows of the flattened text whose words best overlap the quote's,
 * case folded. A window needs half the quote's words to be offered at all.
 */
export function nearMisses(target: FlatTarget, query: string, limit = 3): NearMiss[] {
  const normalizedQuery = normalizeForMatch(query).text;
  if (!normalizedQuery) return [];
  const misses: NearMiss[] = [];
  const add = (range: QuoteRange) => {
    if (misses.length >= limit) return;
    if (misses.some((other) => range.from < other.to && other.from < range.to)) return;
    misses.push({ ...range, quotedText: quotedTextAt(target.node, range.from, range.to) });
  };

  if (normalizedQuery.length >= NEAR_MISS_ENDS_MIN) {
    const ends = findQuoteInTarget(target, query, { tiers: ["ends"] });
    if (ends) add(ends);
  }

  for (const window of overlapWindows(target.text, normalizedQuery, limit)) {
    add(rangeFromFlat(target, window.start, window.end));
  }
  return misses;
}

/** The character trigrams of a text, letters and digits only, case folded, words kept apart by a space. */
function trigramsOf(text: string): Set<string> {
  const folded = ` ${[...text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]).join(" ")} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= folded.length; i++) grams.add(folded.slice(i, i + 3));
  return grams;
}

/**
 * The stretches of `text` most like `query`, best first and never
 * overlapping: windows starting on a word, about as long as the query,
 * scored by the share of the query's character trigrams they hold. Trigrams
 * rather than whole words, so a misremembered word ("egotism" for "egoism")
 * still counts for most of itself, and a window of common words ("of the")
 * counts for little. A window needs half the query's trigrams to be offered.
 * Offsets into `text`. What `nearMisses` offers a quote that matched nowhere,
 * and the PDF locator's equivalent over a page.
 */
export function overlapWindows(
  text: string,
  query: string,
  limit: number,
): { start: number; end: number; score: number }[] {
  const wanted = trigramsOf(query);
  if (wanted.size === 0) return [];
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  const length = [...query.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]).join(" ").length;
  const scored: { start: number; end: number; score: number }[] = [];
  let last = 0;
  for (let first = 0; first < words.length; first++) {
    if (last < first) last = first;
    // The last word whose end is nearest the query's length from here.
    while (last + 1 < words.length && words[last + 1].end - words[first].start <= length) last++;
    const start = words[first].start;
    const end = words[last].end;
    const grams = trigramsOf(text.slice(start, end));
    let shared = 0;
    for (const gram of wanted) if (grams.has(gram)) shared++;
    scored.push({ start, end, score: shared / wanted.size });
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  const windows: { start: number; end: number; score: number }[] = [];
  for (const window of scored) {
    if (window.score < 0.5 || windows.length >= limit) break;
    if (windows.some((w) => window.start < w.end && w.start < window.end)) continue;
    windows.push(window);
  }
  return windows;
}
