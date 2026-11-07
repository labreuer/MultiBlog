import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  chipCodesFor,
  filterByContext,
  findAllExact,
  findByEnds,
  flattenForIdentity,
  nearMisses,
  normalizeForMatch,
  type FlatTarget,
  type NearMiss,
  type QuoteMatch,
  type QuoteRange,
} from "./comment-quote-match";
import { chipsBetween, chipsIn, sameChipFields } from "./entity-chips/renderings";

// docs/MCP.md §7 — what counts as a match wherever the MCP server finds a
// quote in a doc or an annotation body: reads `around` a quote, anchors, and
// the passages an edit replaces.
//
// Pure and browser-safe, over a flattened target (comment-quote-match.ts), so
// the rules are a unit table (quote-resolve.test.ts). The caller turns a
// resolution into an answer: several matches are `ambiguous` for a write and
// every occurrence for a read; none is `no_match` with the near misses.
//
// The rules:
//
// - **The matcher's own folding**: typographic quotes and dashes made plain,
//   whitespace collapsed, NFKC per character. Neither case nor punctuation.
// - **One retry, for Markdown.** A quote that misses as written is parsed as
//   Markdown and matched again as the text that yields, so `the **key**
//   claim`, copied out of a Markdown read, still lands. A quote from a text
//   read needs no retry.
// - **A chip in that Markdown is matched by identity** (docs/ENTITY_CHIPS.md,
//   MCP item 3). Where the chip parse finds a chip's syntax in the quote
//   (`QuoteSpec.chips`, which the caller resolves, since that takes the
//   database), the quote is matched against the target's identity text, each
//   chip one character per thing it points at, so `[see @radner2012, p. 49]`
//   finds its citation whatever style, number or label the doc shows. Of
//   several occurrences, those whose chips' other fields agree with the
//   quote's win; one occurrence that disagrees still matches, marked
//   `chipsDiffer`, for the caller to report or, for an edit, refuse. When
//   the identity text holds no match, the quote is matched as the text its
//   plain Markdown parse yields, as for any other.
// - **Only an exact match counts.** The `ends` tier only ever suggests.
// - **A long passage may be named by its ends**: `start` and `end` in place
//   of `quote`, from the first word of `start` to the last word of the first
//   `end` after it. It is ambiguous when its `start` is.
// - **`prefix` and `suffix`** narrow the occurrences to those they stand
//   beside.

type QuoteParts<T> = { quote?: T; start?: T; end?: T; prefix?: T; suffix?: T };

/**
 * A spec's parts read through the chip parse, each as top-level blocks with
 * every chip resolved to what it points at (entity-chips/quote-chips.ts).
 * JSON, so an edit's target carries it to the collab server.
 */
export type ChipQuoteForm = QuoteParts<JSONContent[]>;

/** A quote as a client names it: the W3C TextQuoteSelector's `exact`, or a passage's two ends. */
export type QuoteSpec = QuoteParts<string> & {
  /** The parts read through the chip parse, when any of them holds a chip's syntax. */
  chips?: ChipQuoteForm;
};

/** A match found through `QuoteSpec.chips`, whose chips name the right things with other fields than the target's. */
export type ResolvedMatch = QuoteMatch & { chipsDiffer?: true };

export type QuoteResolution =
  | {
      kind: "found";
      matches: ResolvedMatch[];
      /** Whether the matches came from the quote read as Markdown, not as written. */
      viaMarkdown: boolean;
    }
  | { kind: "none"; nearMisses: NearMiss[] };

/** Whether a spec names anything: a quote, or both ends. */
export function hasQuote(spec: QuoteSpec): boolean {
  return !!(spec.quote?.trim() || (spec.start?.trim() && spec.end?.trim()));
}

/**
 * Every occurrence of the spec in `target`, or the near misses when there are
 * none. `asText` is the Markdown retry (markdown-import.ts's `markdownToText`),
 * passed in so this module stays free of the editor's extension lists.
 */
export function resolveQuote(
  target: FlatTarget,
  spec: QuoteSpec,
  asText: (markdown: string) => string,
  nearMissLimit = 3,
): QuoteResolution {
  const attempt = (form: QuoteSpec): QuoteMatch[] => {
    const matches = form.quote?.trim()
      ? findAllExact(target, form.quote)
      : findByEnds(target, form.start ?? "", form.end ?? "");
    return filterByContext(target, matches, { prefix: form.prefix, suffix: form.suffix });
  };

  const asWritten = attempt(spec);
  if (asWritten.length > 0) return { kind: "found", matches: asWritten, viaMarkdown: false };

  const byIdentity = spec.chips ? identityMatches(target.node, spec.chips) : [];
  if (byIdentity.length > 0) return { kind: "found", matches: byIdentity, viaMarkdown: true };

  const reread = markdownForm(spec, asText);
  if (reread) {
    const viaMarkdown = attempt(reread);
    if (viaMarkdown.length > 0) return { kind: "found", matches: viaMarkdown, viaMarkdown: true };
  }

  const probe = spec.quote?.trim() ? spec.quote : (spec.start ?? "");
  return { kind: "none", nearMisses: nearMisses(target, probe, nearMissLimit) };
}

/**
 * The chip form's occurrences in `node`'s identity text, those whose chips
 * also agree in every field preferred; or, where none agrees, every
 * occurrence, the one of them marked `chipsDiffer`.
 */
function identityMatches(node: PMNode, form: ChipQuoteForm): ResolvedMatch[] {
  const schema = node.type.schema;
  const parts: QuoteParts<PMNode> = {};
  for (const name of ["quote", "start", "end", "prefix", "suffix"] as const) {
    const blocks = form[name];
    if (!blocks) continue;
    try {
      parts[name] = schema.nodeFromJSON({ type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] });
    } catch {
      // A form this node's schema can't hold (a chip in a body with none) matches nothing.
      return [];
    }
  }
  const codes = chipCodesFor(node.textContent + Object.values(parts).map((part) => part.textContent).join(""));
  const target = flattenForIdentity(node, codes);
  const text = (part: PMNode | undefined) => (part ? flattenForIdentity(part, codes).text : undefined);
  const quote = text(parts.quote);
  const matches = filterByContext(
    target,
    quote?.trim() ? findAllExact(target, quote) : findByEnds(target, text(parts.start) ?? "", text(parts.end) ?? ""),
    { prefix: text(parts.prefix), suffix: text(parts.suffix) },
  );
  if (matches.length === 0) return [];

  // The quote's own chips, against the passage's: all of them for a quote,
  // and for a passage named by its ends, its first chips against `start`'s
  // and its last against `end`'s.
  const chipsOf = (part: PMNode | undefined) => (part ? chipsIn(part) : []);
  const agrees = (match: QuoteMatch) => {
    const inPassage = chipsBetween(node, match.from, match.to);
    const pairs = parts.quote
      ? chipsOf(parts.quote).map((chip, i) => [chip, inPassage[i]] as const)
      : [
          ...chipsOf(parts.start).map((chip, i) => [chip, inPassage[i]] as const),
          ...chipsOf(parts.end)
            .reverse()
            .map((chip, i) => [chip, inPassage[inPassage.length - 1 - i]] as const),
        ];
    return pairs.every(([quoted, there]) => there !== undefined && sameChipFields(quoted, there));
  };
  const agreeing = matches.filter(agrees);
  if (agreeing.length > 0) return agreeing;
  return matches.length === 1 ? [{ ...matches[0], chipsDiffer: true }] : matches;
}

/** The spec with each part read as Markdown, or null when that changes nothing. */
function markdownForm(spec: QuoteSpec, asText: (markdown: string) => string): QuoteSpec | null {
  const reread = (value: string | undefined) => (value === undefined ? undefined : asText(value));
  const form: QuoteSpec = {
    quote: reread(spec.quote),
    start: reread(spec.start),
    end: reread(spec.end),
    prefix: reread(spec.prefix),
    suffix: reread(spec.suffix),
  };
  const same = (a: string | undefined, b: string | undefined) =>
    (a === undefined ? "" : normalizeForMatch(a).text) === (b === undefined ? "" : normalizeForMatch(b).text);
  const unchanged =
    same(form.quote, spec.quote) &&
    same(form.start, spec.start) &&
    same(form.end, spec.end) &&
    same(form.prefix, spec.prefix) &&
    same(form.suffix, spec.suffix);
  return unchanged ? null : form;
}

/** How many characters of the flat text either side of a hit an error shows. */
export const CONTEXT_CHARS = 40;

/** A hit's surroundings in the flat text, `…before [hit] after…`, for an `ambiguous` or `no_match` answer. */
export function contextOf(target: FlatTarget, range: QuoteRange, chars = CONTEXT_CHARS): string {
  const start = target.positions.findIndex((p) => p >= range.from);
  let end = target.positions.length;
  for (let i = target.positions.length - 1; i >= 0; i--) {
    if (target.positions[i] < range.to) {
      end = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const before = target.text.slice(Math.max(0, start - chars), start);
  const after = target.text.slice(end, end + chars);
  return `${start - chars > 0 ? "…" : ""}${before}[${target.text.slice(start, end)}]${after}${end + chars < target.text.length ? "…" : ""}`;
}
