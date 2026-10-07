// docs/FULLTEXT.md — one search over docs, posts, PDFs, annotations and
// comments, in Postgres's own full-text search.
//
// **A plain module that takes an explicit actor**, never exported from a
// `"use server"` file: the page calls it with the session's user, the quote
// picker with the public scope, and the MCP server's `search` tool will call
// it with a token's user (§8). Nothing here reads a session.
//
// **The index holds no permission data** (§2). Each kind asks Prisma for the
// ids this viewer may read, under the filters, through the `where` helper
// that states its read rule; the SQL that matches and ranks then runs only
// inside those ids. Five queries wearing five existing predicates, never one
// UNION — the reason /tag is three: a merged query re-implements every read
// rule at once, the easiest leak to write and the hardest to see.

import { canViewDocs, canViewFiles } from "@/lib/role-checks";
import { dayRangeToInstants } from "./dates";
import { hasFilters, SEARCH_KINDS, type SearchKind, type SearchParams } from "./params";
import { isEmptyQuery, websearchQuery, windowOf, type TsQuery } from "./sql";
import { asYouTypeQuery } from "./as-you-type";
import { correctQuery } from "./correct";
import { AUTHORED_KINDS, searchAuthorOptions } from "./authors";
import { docsSearch } from "./docs";
import { postsSearch } from "./posts";
import { pdfsSearch } from "./pdfs";
import { annotationsSearch } from "./annotations";
import { commentsSearch } from "./comments";
import type { KindContext, KindSearch } from "./context";
import type { SearchActor, SearchResult, SearchScope, SearchSection } from "./types";

export type { SearchActor, SearchResult, SearchScope, SearchSection } from "./types";

/** Hits per section on the overview, before its "All N" link (§7; §10 item 6). */
export const OVERVIEW_SIZE = 5;
/** Hits per page when one kind is selected. */
export const PAGE_SIZE = 20;

/**
 * The kinds this viewer may search at all, in page order. A signed-out
 * reader searches posts and comments only; the public scope is the same two
 * whoever is asking.
 */
export function readableKinds(actor: SearchActor, scope: SearchScope = "viewer"): SearchKind[] {
  if (scope === "public" || !actor) return ["posts", "comments"];
  const docs = canViewDocs(actor.role);
  const files = canViewFiles(actor.role);
  return SEARCH_KINDS.filter((kind) => {
    switch (kind) {
      case "docs":
        return docs;
      case "pdfs":
        return files;
      case "annotations":
        return docs || files;
      case "posts":
      case "comments":
        return true;
    }
  });
}

const SEARCHES: { [K in SearchKind]: KindSearch<unknown> } = {
  docs: docsSearch,
  posts: postsSearch,
  pdfs: pdfsSearch,
  annotations: annotationsSearch,
  comments: commentsSearch,
};

/** One kind's section: its count, and the hits in the window. */
async function sectionFor(
  kind: SearchKind,
  ctx: KindContext,
  query: TsQuery | null,
  window: { offset: number; limit: number },
): Promise<SearchSection> {
  const ordered = await SEARCHES[kind].match(ctx, query);
  const hits = await SEARCHES[kind].hits(ctx, windowOf(ordered, window), query);
  // The cast is the price of one table of searchers: SEARCHES[kind] is the
  // searcher for exactly this kind, so its hits are this kind's.
  return { kind, total: ordered.length, hits } as SearchSection;
}

export type SearchOptions = {
  scope?: SearchScope;
  /**
   * Treat the last word as a prefix still being typed (§5) — the quote
   * picker's mode. Never corrected: a half-typed word is not a typo.
   */
  asYouType?: boolean;
  /** Leave out this post and its comments: the quote picker's own host post. */
  excludePostId?: string;
  /** Hits per section, in place of the overview's or a page's. */
  pageSize?: number;
  /**
   * False to skip building the author picker, for a caller that shows none
   * (the quote picker). Any author slugs requested are then ignored.
   */
  authorOptions?: boolean;
  /** Tag ids every hit must carry one of (docs/MCP.md §11): the MCP server's filter, which the page doesn't offer. */
  tagIds?: string[];
};

export async function search(
  actor: SearchActor,
  requested: SearchParams,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const scope = opts.scope ?? "viewer";
  const readable = readableKinds(actor, scope);
  const options = opts.authorOptions === false ? [] : await searchAuthorOptions(actor, scope);

  // Slugs not on this viewer's picker are dropped, as /docs drops its own.
  const authors = options.filter((option) => requested.authors.includes(option.slug));
  const params: SearchParams = { ...requested, authors: authors.map((author) => author.slug) };

  const selected = (params.kinds ?? readable).filter((kind) => readable.includes(kind));
  const withoutAuthors = authors.length > 0 ? selected.filter((kind) => !AUTHORED_KINDS.includes(kind)) : [];
  const kinds = selected.filter((kind) => !withoutAuthors.includes(kind));
  // Pagination when exactly one kind was asked for (§6), even if an author
  // filter then leaves it out.
  const paginated = params.kinds !== null && params.kinds.length === 1;
  const pageSize = opts.pageSize ?? (paginated ? PAGE_SIZE : OVERVIEW_SIZE);

  const result = {
    params,
    readableKinds: readable,
    kinds,
    withoutAuthors,
    authorOptions: options.map(({ slug, name }) => ({ slug, name })),
    sections: [] as SearchSection[],
    corrected: false,
    paginated,
    pageSize,
  };

  const tagIds = opts.tagIds ?? [];
  if (!params.q && !hasFilters(params) && tagIds.length === 0) return { ...result, status: "idle" };
  // Every kind asked for is one this viewer can't search: nothing to run, and
  // nothing for typo correction to look through.
  if (kinds.length === 0) return { ...result, status: "ok" };

  let query: TsQuery | null = null;
  if (params.q) {
    query = opts.asYouType ? await asYouTypeQuery(params.q) : websearchQuery(params.q);
    if (!query || (await isEmptyQuery(query))) return { ...result, status: "stop-words" };
  }

  const ctx: KindContext = {
    actor,
    scope,
    authorIds: authors.map((author) => author.id),
    created: dayRangeToInstants(params.created, params.tz),
    updated: dayRangeToInstants(params.updated, params.tz),
    excludePostId: opts.excludePostId ?? null,
    tagIds,
    memo: new Map(),
  };
  const window = { offset: paginated ? (params.page - 1) * pageSize : 0, limit: pageSize };
  // Concurrently: each is a handful of queries over its own tables, and the
  // page waits for the slowest anyway.
  const run = (q: TsQuery | null) => Promise.all(kinds.map((kind) => sectionFor(kind, ctx, q, window)));

  const sections = await run(query);

  // §5: typo correction, only when every selected kind came back empty, and
  // never when asked for the query exactly as typed. The corrected search is
  // shown only if it found something; otherwise the page says nothing
  // matched, which is what happened.
  if (query && !opts.asYouType && !params.exact && sections.every((section) => section.total === 0)) {
    const countHits = async (q: TsQuery) =>
      (await Promise.all(kinds.map((kind) => SEARCHES[kind].match(ctx, q)))).reduce((n, ids) => n + ids.length, 0);
    const corrected = await correctQuery(params.q, query, countHits);
    if (corrected) {
      const retried = await run(corrected);
      if (retried.some((section) => section.total > 0)) return { ...result, status: "ok", sections: retried, corrected: true };
    }
  }
  return { ...result, status: "ok", sections };
}
