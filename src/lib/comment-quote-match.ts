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
