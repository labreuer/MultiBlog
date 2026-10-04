// docs/FULLTEXT.md §4 — the SQL every kind's search shares: building the
// tsquery, matching and ranking inside a set of ids, and snippets.
//
// Server-only (Prisma). **Every query here runs inside ids Prisma has
// already chosen** under the kind's read rule (§2); nothing in this file
// knows who may read what, and nothing joins to a table that would let it
// find out. The table names interpolated with Prisma.raw are a closed union
// of constants, never input.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { HEADLINE_DELIMITERS, SNIPPET_OPTIONS, TITLE_OPTIONS, parseHeadline, type HeadlineFragment } from "./headline";

/** The configuration add_full_text_search created: `english` with `unaccent` ahead of the stemmer. */
const CONFIG = Prisma.sql`'public.english_unaccent'::regconfig`;

/**
 * A tsquery expression, ready to interpolate: what every match and snippet
 * below takes. It may be a function call, a cast of a literal or a
 * `ts_rewrite` of either, so it is always joined in as a one-row subselect —
 * a bare cast isn't a valid FROM item.
 */
export type TsQuery = Prisma.Sql;

/** The query as typed, in `websearch_to_tsquery`'s syntax: words ANDed, "phrases", `or`, `-word`. */
export function websearchQuery(text: string): TsQuery {
  return Prisma.sql`websearch_to_tsquery(${CONFIG}, ${text})`;
}

/**
 * Whether a query parses to nothing — every word a stop word. Postgres then
 * matches nothing at all, and the page says why rather than showing an empty
 * result that reads as "no matches" (§4).
 */
export async function isEmptyQuery(query: TsQuery): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ nodes: number }[]>(Prisma.sql`SELECT numnode(${query})::int AS nodes`);
  return row.nodes === 0;
}

/** The tables with a `search_vector` keyed by a single `id`. */
export type RankedTable = "doc" | "post" | "annotation" | "comment" | "file";

/**
 * Each of `ids` whose vector matches, with its rank — `ts_rank_cd`
 * normalised by 32 (rank / (rank + 1)), so a long doc's many matches don't
 * swamp a short one's. Unordered; `orderRanked` sorts, because the tiebreak
 * ("newest first") is a different date per kind and some are computed.
 */
export async function rankRows(table: RankedTable, ids: string[], query: TsQuery): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; rank: number }[]>(Prisma.sql`
    SELECT t.id, ts_rank_cd(t.search_vector, q.query, 32)::float8 AS rank
    FROM ${Prisma.raw(`"${table}"`)} t CROSS JOIN (SELECT ${query} AS query) AS q
    WHERE t.id = ANY(${ids}) AND t.search_vector @@ q.query`);
  return new Map(rows.map((row) => [row.id, row.rank]));
}

/** Best rank first, then the newest by `dateOf`, then by id so a page boundary never shuffles. */
export function orderRanked(ranks: Map<string, number>, dateOf: (id: string) => Date | null): string[] {
  return [...ranks.keys()].sort(
    (a, b) => ranks.get(b)! - ranks.get(a)! || byNewest(dateOf(a), dateOf(b)) || a.localeCompare(b),
  );
}

/** Newest first by `dateOf`, then by id: the order when there is no text to rank by (§4). */
export function orderNewest(ids: string[], dateOf: (id: string) => Date | null): string[] {
  return [...ids].sort((a, b) => byNewest(dateOf(a), dateOf(b)) || a.localeCompare(b));
}

function byNewest(a: Date | null, b: Date | null): number {
  return (b?.getTime() ?? -Infinity) - (a?.getTime() ?? -Infinity) || 0;
}

/** Strips the snippet delimiters from a text before `ts_headline` sees it, so the source can't forge a match. */
function cleaned(text: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(${text}, ${HEADLINE_DELIMITERS}, '')`;
}

/** How much of a text a no-query listing shows (§4: "the start of its text"). */
const EXCERPT_LENGTH = 240;

function excerpt(text: string): HeadlineFragment[] {
  const trimmed = text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH).trimEnd()}…` : text;
  return parseHeadline(trimmed);
}

export type Snippets = { title: HeadlineFragment[]; body: HeadlineFragment[] };

/**
 * Title and body snippets for the rows on screen, never more (§3: snippets
 * are the cost to manage — about 3.5 ms for a long doc). `body` is an SQL
 * expression over the table aliased `t` — `public.prose_text(t.prose_json)`
 * for a doc or post, a text column for the rest — and `title` likewise, or
 * null for a kind with none.
 *
 * With no query, the start of the body and the title as stored.
 */
export async function snippetsFor(
  table: RankedTable,
  ids: string[],
  query: TsQuery | null,
  columns: { body: Prisma.Sql; title: Prisma.Sql | null },
): Promise<Map<string, Snippets>> {
  if (ids.length === 0) return new Map();
  const title = columns.title ?? Prisma.sql`''`;
  const from = Prisma.raw(`"${table}"`);
  const rows = query
    ? await prisma.$queryRaw<{ id: string; title: string; body: string }[]>(Prisma.sql`
        SELECT t.id,
          ts_headline(${CONFIG}, ${cleaned(title)}, q.query, ${TITLE_OPTIONS}) AS title,
          ts_headline(${CONFIG}, ${cleaned(columns.body)}, q.query, ${SNIPPET_OPTIONS}) AS body
        FROM ${from} t CROSS JOIN (SELECT ${query} AS query) AS q
        WHERE t.id = ANY(${ids})`)
    : await prisma.$queryRaw<{ id: string; title: string; body: string }[]>(Prisma.sql`
        SELECT t.id, ${cleaned(title)} AS title, left(${cleaned(columns.body)}, ${EXCERPT_LENGTH + 1}) AS body
        FROM ${from} t
        WHERE t.id = ANY(${ids})`);
  return new Map(
    rows.map((row) => [
      row.id,
      { title: parseHeadline(row.title), body: query ? parseHeadline(row.body) : excerpt(row.body) },
    ]),
  );
}

/**
 * Texts headlined against the query, in one round trip, for passages the
 * caller has in hand rather than in a column: an annotation's quoted passage,
 * which for a mark-anchored one lives only in its doc's body. "" gives [].
 */
export async function headlineTexts(texts: string[], query: TsQuery | null): Promise<HeadlineFragment[][]> {
  if (!query) return texts.map((text) => (text ? excerpt(text) : []));
  if (texts.length === 0) return [];
  const rows = await prisma.$queryRaw<{ i: number; body: string }[]>(Prisma.sql`
    SELECT u.i::int AS i, ts_headline(${CONFIG}, ${cleaned(Prisma.sql`u.text`)}, q.query, ${SNIPPET_OPTIONS}) AS body
    FROM unnest(${texts}::text[]) WITH ORDINALITY AS u(text, i) CROSS JOIN (SELECT ${query} AS query) AS q`);
  const byIndex = new Map(rows.map((row) => [row.i, row.body]));
  return texts.map((text, index) => (text ? parseHeadline(byIndex.get(index + 1) ?? "") : []));
}

export const sqlConfig = CONFIG;
export const cleanedText = cleaned;

/** The rows on one screen of an ordered list. */
export function windowOf<T>(items: T[], window: { offset: number; limit: number }): T[] {
  return items.slice(window.offset, window.offset + window.limit);
}
