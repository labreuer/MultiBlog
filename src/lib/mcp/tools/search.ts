import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { search, PAGE_SIZE, OVERVIEW_SIZE } from "@/lib/search";
import { SEARCH_KINDS, DEFAULT_TIME_ZONE, isTimeZone, parseDay, type SearchParams } from "@/lib/search/params";
import { isEmptyQuery, websearchQuery, headlineTexts, sqlConfig, type TsQuery } from "@/lib/search/sql";
import { correctQuery } from "@/lib/search/correct";
import { matchPages, pageSnippets } from "@/lib/search/pdfs";
import { searchActorOf } from "@/lib/actor";
import { searchSections, docText } from "@/lib/doc-text";
import { loadDocState } from "@/lib/doc-state";
import { headingAbove } from "@/lib/doc-text";
import { ApiError, ERROR_LIST_CAP, invalid } from "@/lib/api/errors";
import { defineTool, objectRef, type McpContext, type ToolResult } from "../tool";
import { decodeCursor, encodeCursor, markedSnippet } from "../shape";
import { shapeSearch } from "../search-shape";
import { readableContainer, type ResolvedDoc, type ResolvedFile } from "../resolve";
import { pdfLabels } from "../read/pdf-meta";

// docs/MCP.md §14 — search, and listing, across kinds: a parse and a call to
// the same `search()` the page uses, with the token's user as the actor in the
// `viewer` scope. There is no second search and no second statement of any
// read rule.
//
// **A strict parse first.** The page's `parseSearchParams` falls back to a
// default on anything malformed, and behind a tool each fallback silently
// changes the search — `kinds=doc` would mean every kind, a mistyped date
// would drop its filter, an unknown zone would become UTC. The schema below
// refuses each as `invalid` instead.

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a slug");
const day = z
  .string()
  .refine((value) => parseDay(value) === value, "a real day, YYYY-MM-DD");

const input = z.strictObject({
  q: z
    .string()
    .max(200)
    .optional()
    .describe('Words, "a phrase", or, -word. Without q, a filter lists what it selects, newest first.'),
  kinds: z.array(z.enum(SEARCH_KINDS)).min(1).max(5).optional().describe("One kind pages 20 at a time; several give 5 each."),
  authors: z.array(slug).min(1).max(20).optional().describe("Author slugs: docs, posts and annotations by any of them."),
  tags: z.array(slug).min(1).max(20).optional().describe("Tag slugs: what carries any of them."),
  created_from: day.optional(),
  created_to: day.optional(),
  updated_from: day.optional(),
  updated_to: day.optional(),
  tz: z.string().refine(isTimeZone, "an IANA time zone").optional().describe("The zone the days are in; UTC by default."),
  exact: z.boolean().optional().describe("No typo correction. Use it whenever the question is whether something exists."),
  within: objectRef.optional().describe("A doc (ranks its sections) or a PDF (ranks every matching page); needs q."),
  limit: z.number().int().min(1).max(PAGE_SIZE).optional().describe("Hits per page, with one kind or within; 20 at most."),
  cursor: z.string().max(200).optional().describe("The `next` an earlier page returned."),
});

const output = z.looseObject({});

/** Tag slugs to ids, through the soft-delete filter and each tag's past slugs; an unknown slug is refused. */
async function tagIdsFor(slugs: string[]): Promise<string[]> {
  const live = await prisma.tag.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
  const found = new Map(live.map((tag) => [tag.slug, tag.id]));
  const missing = slugs.filter((s) => !found.has(s));
  if (missing.length > 0) {
    const moved = await prisma.tagSlugHistory.findMany({
      where: { slug: { in: missing }, tag: { deletedAt: null } },
      select: { slug: true, tagId: true },
    });
    for (const row of moved) found.set(row.slug, row.tagId);
  }
  const unknown = slugs.filter((s) => !found.has(s));
  if (unknown.length > 0) {
    throw invalid("No tag has that slug.", { slugs: unknown.slice(0, ERROR_LIST_CAP) });
  }
  return [...new Set(found.values())];
}

/**
 * `search` run as the page runs it, shaped for the model. Shared with `read`
 * of /tag/<slug> and /authors/<slug>, which are listings of exactly this kind.
 */
export async function runSearch(
  ctx: McpContext,
  args: Omit<z.infer<typeof input>, "within">,
): Promise<ToolResult> {
  const oneKind = args.kinds?.length === 1;
  if (args.cursor && !oneKind) throw invalid("A cursor pages one kind; pass that one kind in kinds.");
  const cursor = decodeCursor(args.cursor, args.limit ?? PAGE_SIZE);
  if (cursor.offset % cursor.size !== 0) throw invalid("That cursor isn't one this server gave out.");
  const params: SearchParams = {
    q: (args.q ?? "").trim(),
    kinds: args.kinds ? SEARCH_KINDS.filter((kind) => args.kinds!.includes(kind)) : null,
    authors: args.authors ?? [],
    created: { from: args.created_from ?? null, to: args.created_to ?? null },
    updated: { from: args.updated_from ?? null, to: args.updated_to ?? null },
    tz: args.tz ?? DEFAULT_TIME_ZONE,
    page: Math.floor(cursor.offset / cursor.size) + 1,
    exact: args.exact ?? false,
  };
  const tagIds = args.tags ? await tagIdsFor(args.tags) : [];
  const result = await search(searchActorOf(ctx.actor), params, {
    pageSize: oneKind ? cursor.size : OVERVIEW_SIZE,
    tagIds,
  });

  // search() keeps only the slugs on this viewer's author picker, and over
  // everyone's when it drops them all. Naming the refused slugs leaks nothing:
  // the picker's slugs are visible to this viewer already.
  const refused = params.authors.filter((s) => !result.params.authors.includes(s));
  if (refused.length > 0) {
    throw new ApiError("unknown_author", "No author you can see has that slug.", { slugs: refused.slice(0, ERROR_LIST_CAP) });
  }
  if (result.status === "idle") {
    throw invalid("Give q, or a filter (kinds, authors, tags or a date) to list by.");
  }
  return shapeSearch(result, (section) =>
    oneKind && cursor.offset + cursor.size < section.total
      ? encodeCursor({ offset: cursor.offset + cursor.size, size: cursor.size })
      : undefined,
  );
}

/** Each section's text matched and ranked by Postgres's own pieces, in one round trip. */
async function rankTexts(texts: string[], query: TsQuery): Promise<Map<number, number>> {
  if (texts.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ i: number; rank: number }[]>(Prisma.sql`
    SELECT u.i::int AS i, ts_rank_cd(to_tsvector(${sqlConfig}, u.t), q.query, 32)::float8 AS rank
    FROM unnest(${texts}::text[]) WITH ORDINALITY AS u(t, i)
      CROSS JOIN (SELECT ${query} AS query) AS q
    WHERE to_tsvector(${sqlConfig}, u.t) @@ q.query`);
  return new Map(rows.map((row) => [row.i - 1, row.rank]));
}

/**
 * Typo correction for a search within one object, under search's own rule
 * (FULLTEXT.md §5): only when nothing matched, never with `exact`, and only a
 * correction that finds something.
 */
async function withCorrection<T>(
  q: string,
  query: TsQuery,
  exact: boolean,
  count: (query: TsQuery) => Promise<number>,
  run: (query: TsQuery) => Promise<T[]>,
): Promise<{ hits: T[]; corrected: boolean; query: TsQuery }> {
  const hits = await run(query);
  if (hits.length > 0 || exact) return { hits, corrected: false, query };
  const corrected = await correctQuery(q, query, count);
  if (!corrected) return { hits, corrected: false, query };
  const retried = await run(corrected);
  return retried.length > 0 ? { hits: retried, corrected: true, query: corrected } : { hits, corrected: false, query };
}

/**
 * `within` a doc: its sections ranked (docs/MCP.md §6) — computed per request
 * from the doc as read, nothing stored, ranked with search's own configuration
 * and snippets. Each hit carries its heading, its block numbers and its
 * snippet, so the next call is a ranged read of exactly that passage.
 */
async function searchDoc(doc: ResolvedDoc, q: string, exact: boolean, cursorRaw: string | undefined, limit: number) {
  const state = await loadDocState(doc.id);
  const sections = searchSections(state.blocks);
  const texts = sections.map((span) => docText(state.blocks.slice(span.from - 1, span.to)));
  const base = websearchQuery(q);
  if (await isEmptyQuery(base)) return { status: "stop-words", note: "Every word in q is too common to search for." };
  const ranked = async (query: TsQuery) =>
    [...(await rankTexts(texts, query))].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
  const { hits, corrected, query } = await withCorrection(q, base, exact, async (qq) => (await rankTexts(texts, qq)).size, ranked);
  const cursor = decodeCursor(cursorRaw, limit);
  const page = hits.slice(cursor.offset, cursor.offset + cursor.size);
  const snippets = await headlineTexts(
    page.map((index) => texts[index]),
    query,
  );
  return {
    kind: "doc-sections",
    url: `/doc/${doc.slug}`,
    version: state.version?.toString() ?? null,
    total: hits.length,
    ...(corrected ? { corrected: true } : {}),
    hits: page.map((index, k) => {
      const span = sections[index];
      const heading = headingAbove(state.blocks, span.from);
      return {
        ...(heading ? { heading: heading.heading!.text } : {}),
        blocks: span.from === span.to ? String(span.from) : `${span.from}-${span.to}`,
        snippet: markedSnippet(snippets[k] ?? []),
      };
    }),
    ...(cursor.offset + cursor.size < hits.length ? { next: encodeCursor({ offset: cursor.offset + cursor.size, size: cursor.size }) } : {}),
  };
}

/** `within` a PDF: every matching page, best first, paged — where a file's search hit shows three (§8). */
async function searchPdf(file: ResolvedFile, q: string, exact: boolean, cursorRaw: string | undefined, limit: number) {
  const base = websearchQuery(q);
  if (await isEmptyQuery(base)) return { status: "stop-words", note: "Every word in q is too common to search for." };
  const pagesFor = async (query: TsQuery) => (await matchPages([file.id], query)).get(file.id) ?? [];
  const { hits, corrected, query } = await withCorrection(q, base, exact, async (qq) => (await pagesFor(qq)).length, pagesFor);
  const cursor = decodeCursor(cursorRaw, limit);
  const page = hits.slice(cursor.offset, cursor.offset + cursor.size);
  const [snippets, labels] = await Promise.all([pageSnippets(page, query), pdfLabels(file.id)]);
  return {
    kind: "pdf-pages",
    url: `/pdf/${file.slug}`,
    total: hits.length,
    ...(corrected ? { corrected: true } : {}),
    hits: page.map((p) => ({
      page: p.pageIndex + 1,
      ...(labels ? { label: labels[p.pageIndex] } : {}),
      snippet: markedSnippet(snippets.get(`${file.id}:${p.pageIndex}`) ?? []),
    })),
    ...(cursor.offset + cursor.size < hits.length ? { next: encodeCursor({ offset: cursor.offset + cursor.size, size: cursor.size }) } : {}),
  };
}

export const searchTool = defineTool({
  name: "search",
  scope: "READ",
  description:
    "Full-text search over docs, posts, PDFs, annotations and comments you can read — and, with no q, a listing by filter (kinds, authors, tags, dates), newest first. Stemmed and accent-folded; a typo is corrected only when nothing matched, and the answer says corrected:true. Pass exact:true whenever the question is whether something exists. One handle per hit: its url (pass it to read), or an annotation's id. A doc hit's passage is one read away: read the url with around set to a phrase from inside its snippet's fragment. within a doc ranks its sections and gives each one's blocks for a ranged read; within a PDF ranks every matching page.",
  input,
  output,
  readOnly: true,
  destructive: false,
  alwaysLoad: true,
  searchHint: "find full-text query list docs pdfs annotations posts comments tags authors",
  async run(args, ctx) {
    if (args.within !== undefined) {
      if (!args.q?.trim()) throw invalid("within ranks text: give q.");
      for (const key of ["kinds", "authors", "tags", "created_from", "created_to", "updated_from", "updated_to"] as const) {
        if (args[key] !== undefined) throw invalid(`${key} doesn't apply within one object.`);
      }
      const container = await readableContainer(ctx.actor, args.within);
      const limit = args.limit ?? PAGE_SIZE;
      if (container.kind === "doc") return searchDoc(container.doc, args.q.trim(), args.exact ?? false, args.cursor, limit);
      if (container.file.pageCount === null) throw invalid("That file has no pages to search: it isn't a PDF.");
      return searchPdf(container.file, args.q.trim(), args.exact ?? false, args.cursor, limit);
    }
    const rest = { ...args };
    delete rest.within;
    return runSearch(ctx, rest);
  },
});
