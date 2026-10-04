// docs/FULLTEXT.md §5, "Search-as-you-type" — for the quote picker (§8),
// where the reader is mid-word on every keystroke.
//
// The last word is a prefix, matched two ways:
//
// - **`:*` on that word's stem**, which is what a prefix query usually means.
// - **Every lexeme of four or more characters that the typed word begins
//   with.** A typed prefix can run past its word's stem: "organiza" doesn't
//   prefix-match `organ` (organization), nor "mediati" `mediat` (mediating).
//   And every such lexeme, not just the longest: "organiza" begins with both
//   `organ` (organization) and `organiz` (organizational, which stems
//   differently), and taking only the longest would lose "organization".
//
// Everything before the last word is ordinary `websearch_to_tsquery` syntax.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { sqlConfig, websearchQuery, type TsQuery } from "./sql";
import { MIN_CORRECTABLE_LENGTH, lexemeLiteral, splitLastWord } from "./words";

/** Fewer typed characters than this search for nothing yet. */
export const MIN_AS_YOU_TYPE_LENGTH = 2;

/** The query for text still being typed, or null when there is nothing to search for yet. */
export async function asYouTypeQuery(text: string): Promise<TsQuery | null> {
  if (text.trim().length < MIN_AS_YOU_TYPE_LENGTH) return null;
  const { rest, last } = splitLastWord(text);
  if ([...last].length < MIN_AS_YOU_TYPE_LENGTH) return websearchQuery(text);

  // The vocabulary's lexemes are unaccented and lowercased, so the typed
  // word is folded the same way before its prefixes are looked up — by
  // primary key, one per prefix length, rather than by scanning.
  const [row] = await prisma.$queryRaw<{ stems: string[] | null; lexemes: string[] | null }[]>(Prisma.sql`
    SELECT
      (SELECT array_agg(v.lexeme) FROM unnest(to_tsvector(${sqlConfig}, ${last})) AS v) AS stems,
      (SELECT array_agg(l.lexeme ORDER BY l.lexeme)
         FROM search_lexeme l
         WHERE l.lexeme = ANY (
           SELECT left(t.word, n)
           FROM (SELECT lower(public.unaccent(${last})) AS word) AS t,
                generate_series(${MIN_CORRECTABLE_LENGTH}, length(t.word)) AS n
         )) AS lexemes`);

  const alternatives: string[] = [];
  // A hyphenated word stems to several lexemes; its prefix form needs them all.
  if (row.stems && row.stems.length > 0) {
    alternatives.push(`(${row.stems.map((stem) => `${lexemeLiteral(stem)}:*`).join(" & ")})`);
  }
  for (const lexeme of row.lexemes ?? []) alternatives.push(lexemeLiteral(lexeme));
  // A stop word in progress ("the") contributes nothing, and the rest stands alone.
  if (alternatives.length === 0) return rest.trim() ? websearchQuery(rest) : null;

  const prefix = Prisma.sql`${alternatives.join(" | ")}::tsquery`;
  // An empty `websearch_to_tsquery` drops out of `&&`, so a single word in
  // progress is the prefix alone.
  return Prisma.sql`(${websearchQuery(rest)} && ${prefix})`;
}
