// docs/FULLTEXT.md §5 — the pure halves of fuzzy matching: which typed words
// typo correction may touch, how a lexeme is written as a tsquery literal,
// and where search-as-you-type's last word begins.
//
// Browser-safe and Prisma-free, so the rules are a unit test.

/** A word shorter than this is never corrected: too few trigrams to be similar to anything. */
export const MIN_CORRECTABLE_LENGTH = 4;

/**
 * The words in a query that typo correction may replace: not inside a
 * "quoted phrase", not negated with a leading `-`, not the `or` operator,
 * and at least four characters long.
 *
 * Written against `websearch_to_tsquery`'s syntax, which is what the query
 * is parsed with. A token holding punctuation — `macintire,` or `e-mail` —
 * is split at it the way the parser splits it, and each piece judged on its
 * own; whether a piece is a stop word is for the configuration to say
 * (correct.ts asks it), not this.
 */
export function correctableWords(query: string): string[] {
  const words: string[] = [];
  let inQuote = false;
  for (const token of query.split(/(")|\s+/)) {
    if (token === undefined || token === "") continue;
    if (token === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote || token.startsWith("-") || token.toLowerCase() === "or") continue;
    for (const piece of token.split(/[^\p{L}\p{N}]+/u)) {
      if ([...piece].length >= MIN_CORRECTABLE_LENGTH) words.push(piece);
    }
  }
  return [...new Set(words)];
}

/**
 * A lexeme as a tsquery literal: quoted, with `'` doubled and `\` escaped,
 * so that casting it to tsquery yields exactly that lexeme and nothing else.
 *
 * **A lexeme never goes back through `to_tsquery`**, which would stem a word
 * that is already a stem — and stemming twice doesn't always give the same
 * result: "agreed" stems to `agre`, and `agre` to `agr` (§5, step 5).
 */
export function lexemeLiteral(lexeme: string): string {
  return `'${lexeme.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * Splits typed text for search-as-you-type into the finished part and the
 * word still being typed. Nothing is "still being typed" — `last` is "" —
 * when the text ends in a space, or when the last word is negated or inside
 * an open quote, where a prefix match would change what the reader asked
 * for rather than finish it.
 */
export function splitLastWord(text: string): { rest: string; last: string } {
  const quotes = (text.match(/"/g) ?? []).length;
  if (/\s$/.test(text) || quotes % 2 === 1) return { rest: text, last: "" };
  const match = /^([\s\S]*?)(\S+)$/u.exec(text);
  if (!match) return { rest: text, last: "" };
  const [, rest, last] = match;
  if (last.startsWith("-") || last.includes('"') || last.toLowerCase() === "or") return { rest: text, last: "" };
  return { rest, last };
}
