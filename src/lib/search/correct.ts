// docs/FULLTEXT.md §5 — typo correction, when a search finds nothing.
//
// **Why a global vocabulary leaks nothing.** `search_lexeme` holds every
// word in every vector, including text this viewer can't read. But whether
// correction runs depends only on the viewer's own hits, and a candidate is
// used only if it has hits the viewer can read — so a word that exists only
// in text they can't read never changes what they see. The tempting
// alternative, suggesting a word whenever the typed one isn't in the
// vocabulary, would let a signed-out reader probe private docs: no
// suggestion would mean "this word exists somewhere".

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { sqlConfig, type TsQuery } from "./sql";
import { correctableWords, lexemeLiteral } from "./words";

/** How many of a miss's nearest lexemes are tried (§5, step 4). */
const CANDIDATES = 5;
/** And how near each must be, by trigram similarity. */
const MIN_SIMILARITY = 0.4;

/** A query matching exactly this lexeme — never through `to_tsquery`, which would stem a stem. */
export function lexemeQuery(lexeme: string): TsQuery {
  return Prisma.sql`${lexemeLiteral(lexeme)}::tsquery`;
}

/**
 * The query with each typo replaced by its likeliest correction, or null when
 * there is nothing to correct.
 *
 * 1. **Which words qualify**: not quoted or negated, four or more characters,
 *    and a single lexeme under the configuration (so not a stop word).
 * 2. **Misses**: the ones whose lexeme alone has no hit this viewer can read
 *    under the current filters — `countHits` is the search itself.
 * 3. **Candidates**: a miss's five most similar lexemes in the vocabulary,
 *    each counted the same way; the one with the most hits wins. Similarity
 *    alone would pick wrong: "wittgenstien" is nearer `wittgenst` (in one doc
 *    of the largest corpus) than `wittgenstein` (in eleven).
 * 4. **The rewrite**: `ts_rewrite` swaps each miss for its winner inside the
 *    query as parsed, so phrases, `or` and negations keep their shape.
 */
export async function correctQuery(
  text: string,
  query: TsQuery,
  countHits: (query: TsQuery) => Promise<number>,
): Promise<TsQuery | null> {
  const words = correctableWords(text);
  if (words.length === 0) return null;
  const rows = await prisma.$queryRaw<{ lexemes: string[] | null }[]>(Prisma.sql`
    SELECT (SELECT array_agg(v.lexeme) FROM unnest(to_tsvector(${sqlConfig}, w)) AS v) AS lexemes
    FROM unnest(${words}::text[]) AS w`);
  const lexemes = [...new Set(rows.flatMap((row) => (row.lexemes?.length === 1 ? row.lexemes : [])))];

  const counted = new Map<string, Promise<number>>();
  const hitsFor = (lexeme: string) => {
    let pending = counted.get(lexeme);
    if (!pending) {
      pending = countHits(lexemeQuery(lexeme));
      counted.set(lexeme, pending);
    }
    return pending;
  };

  const counts = await Promise.all(lexemes.map(async (lexeme) => ({ lexeme, hits: await hitsFor(lexeme) })));
  const misses = counts.filter((c) => c.hits === 0).map((c) => c.lexeme);

  let rewritten = query;
  let changed = false;
  for (const miss of misses) {
    const candidates = await prisma.$queryRaw<{ lexeme: string }[]>(Prisma.sql`
      SELECT lexeme FROM search_lexeme
      WHERE lexeme % ${miss} AND lexeme <> ${miss} AND similarity(lexeme, ${miss}) >= ${MIN_SIMILARITY}
      ORDER BY similarity(lexeme, ${miss}) DESC, lexeme
      LIMIT ${CANDIDATES}`);
    let best: { lexeme: string; hits: number } | null = null;
    for (const { lexeme } of candidates) {
      const hits = await hitsFor(lexeme);
      // Most hits wins; on a tie, the nearer — the order they came in.
      if (hits > 0 && (best === null || hits > best.hits)) best = { lexeme, hits };
    }
    if (best) {
      rewritten = Prisma.sql`ts_rewrite(${rewritten}, ${lexemeQuery(miss)}, ${lexemeQuery(best.lexeme)})`;
      changed = true;
    }
  }
  return changed ? rewritten : null;
}
