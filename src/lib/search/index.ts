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
import { hasCitationFilter, hasFilters, MENTIONS_ME, SEARCH_KINDS, splitMentionTokens, type SearchKind, type SearchParams } from "./params";
import { referenceIdsMatching, referencesByKeys } from "@/lib/reference-data";
import { prisma } from "@/lib/prisma";
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

/** The kinds that can hold a citation; the rest drop out while a citation filter is set. */
export const CITATION_KINDS: readonly SearchKind[] = ["docs", "posts", "annotations", "comments"];

/**
 * The reference ids each citation filter names, one list per filter that is
 * set, or null for none (docs/CITATIONS.md, "Search"). A key a reference used
 * to have still names it. A filter that names nothing gives an empty list,
 * which passes nothing. Works are public records, so none of this depends on
 * who is asking.
 */
export async function citedIdsFor(params: Pick<SearchParams, "cites" | "citedTitle" | "citedAuthor">): Promise<string[][] | null> {
  if (!hasCitationFilter(params)) return null;
  const lists: Promise<string[]>[] = [];
  if (params.cites.length > 0) lists.push(referencesByKeys(params.cites).then((found) => [...new Set([...found.values()].map((ref) => ref.id))]));
  if (params.citedTitle) lists.push(referenceIdsMatching(params.citedTitle, "title"));
  if (params.citedAuthor) lists.push(referenceIdsMatching(params.citedAuthor, "author"));
  return Promise.all(lists);
}

/** The kinds that can hold a mention; the rest drop out while a mention filter is set. */
export const MENTION_KINDS: readonly SearchKind[] = ["docs", "posts", "annotations", "comments"];

/**
 * The user ids a mention filter's handles name. `me` is the searcher, and
 * nobody for a signed-out one. A handle nobody has adds no id, so a filter
 * made only of those passes nothing, which is also what a real person with
 * no mention this viewer can read gives: the two can't be told apart.
 */
export async function mentionIdsFor(actor: SearchActor, handles: string[]): Promise<string[]> {
  const ids = new Set<string>();
  if (handles.includes(MENTIONS_ME) && actor) ids.add(actor.userId);
  const slugs = handles.filter((handle) => handle !== MENTIONS_ME);
  if (slugs.length > 0) {
    for (const user of await prisma.user.findMany({ where: { slug: { in: slugs } }, select: { id: true } })) ids.add(user.id);
  }
  return [...ids];
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

  // `@handle` words in the box are mention filters, and the rest is the
  // text. Not for the quote picker, whose last word is still being typed.
  const box = opts.asYouType ? { mentions: [], text: params.q } : splitMentionTokens(params.q);
  const mentions = [...new Set([...params.mentions, ...box.mentions])];
  const text = box.text;

  const selected = (params.kinds ?? readable).filter((kind) => readable.includes(kind));
  const withoutAuthors = authors.length > 0 ? selected.filter((kind) => !AUTHORED_KINDS.includes(kind)) : [];
  const withoutMentions =
    mentions.length > 0 ? selected.filter((kind) => !MENTION_KINDS.includes(kind) && !withoutAuthors.includes(kind)) : [];
  const dropped = [...withoutAuthors, ...withoutMentions];
  const withoutCitations = hasCitationFilter(params) ? selected.filter((kind) => !CITATION_KINDS.includes(kind) && !dropped.includes(kind)) : [];
  const kinds = selected.filter((kind) => !dropped.includes(kind) && !withoutCitations.includes(kind));
  // Pagination when exactly one kind was asked for (§6), even if an author
  // filter then leaves it out.
  const paginated = params.kinds !== null && params.kinds.length === 1;
  const pageSize = opts.pageSize ?? (paginated ? PAGE_SIZE : OVERVIEW_SIZE);

  const result = {
    params,
    readableKinds: readable,
    kinds,
    withoutAuthors,
    mentions,
    withoutMentions,
    withoutCitations,
    authorOptions: options.map(({ slug, name }) => ({ slug, name })),
    sections: [] as SearchSection[],
    corrected: false,
    paginated,
    pageSize,
  };

  const tagIds = opts.tagIds ?? [];
  if (!text && mentions.length === 0 && !hasFilters(params) && tagIds.length === 0) return { ...result, status: "idle" };
  // Every kind asked for is one this viewer can't search: nothing to run, and
  // nothing for typo correction to look through.
  if (kinds.length === 0) return { ...result, status: "ok" };

  let query: TsQuery | null = null;
  if (text) {
    query = opts.asYouType ? await asYouTypeQuery(text) : websearchQuery(text);
    if (!query || (await isEmptyQuery(query))) return { ...result, status: "stop-words" };
  }

  const ctx: KindContext = {
    actor,
    scope,
    authorIds: authors.map((author) => author.id),
    mentionIds: mentions.length > 0 ? await mentionIdsFor(actor, mentions) : null,
    citedIds: await citedIdsFor(params),
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
    const corrected = await correctQuery(text, query, countHits);
    if (corrected) {
      const retried = await run(corrected);
      if (retried.some((section) => section.total > 0)) return { ...result, status: "ok", sections: retried, corrected: true };
    }
  }
  return { ...result, status: "ok", sections };
}
