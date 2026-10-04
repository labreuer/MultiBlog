// docs/FULLTEXT.md — one search over docs, posts, PDFs, annotations and
// comments, in Postgres's own full-text search.
//
// **A plain module that takes an explicit actor**, never exported from a
// `"use server"` file: the page calls it with the session's user, the quote
// picker with the public scope, and the API's search endpoints will call it
// with a token's user (§8). Nothing here reads a session.
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
import { isEmptyQuery, websearchQuery } from "./sql";
import { AUTHORED_KINDS, searchAuthorOptions } from "./authors";
import { searchDocs } from "./docs";
import { searchPosts } from "./posts";
import { searchPdfs } from "./pdfs";
import { searchAnnotations } from "./annotations";
import { searchComments } from "./comments";
import type { KindContext } from "./context";
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

async function searchKind(kind: SearchKind, ctx: KindContext): Promise<SearchSection> {
  switch (kind) {
    case "docs":
      return { kind, ...(await searchDocs(ctx)) };
    case "posts":
      return { kind, ...(await searchPosts(ctx)) };
    case "pdfs":
      return { kind, ...(await searchPdfs(ctx)) };
    case "annotations":
      return { kind, ...(await searchAnnotations(ctx)) };
    case "comments":
      return { kind, ...(await searchComments(ctx)) };
  }
}

export async function search(
  actor: SearchActor,
  requested: SearchParams,
  opts: { scope?: SearchScope } = {},
): Promise<SearchResult> {
  const scope = opts.scope ?? "viewer";
  const readable = readableKinds(actor, scope);
  const options = await searchAuthorOptions(actor, scope);

  // Slugs not on this viewer's picker are dropped, as /docs drops its own.
  const authors = options.filter((option) => requested.authors.includes(option.slug));
  const params: SearchParams = { ...requested, authors: authors.map((author) => author.slug) };

  const selected = (params.kinds ?? readable).filter((kind) => readable.includes(kind));
  const withoutAuthors = authors.length > 0 ? selected.filter((kind) => !AUTHORED_KINDS.includes(kind)) : [];
  const kinds = selected.filter((kind) => !withoutAuthors.includes(kind));
  // Pagination when exactly one kind was asked for (§6), even if an author
  // filter then leaves it out.
  const paginated = params.kinds !== null && params.kinds.length === 1;
  const pageSize = paginated ? PAGE_SIZE : OVERVIEW_SIZE;

  const result = {
    params,
    readableKinds: readable,
    kinds,
    withoutAuthors,
    authorOptions: options.map(({ slug, name }) => ({ slug, name })),
    sections: [] as SearchSection[],
    paginated,
    pageSize,
  };

  if (!params.q && !hasFilters(params)) return { ...result, status: "idle" };

  const query = params.q ? websearchQuery(params.q) : null;
  if (query && (await isEmptyQuery(query))) return { ...result, status: "stop-words" };

  const ctx: KindContext = {
    actor,
    scope,
    query,
    authorIds: authors.map((author) => author.id),
    created: dayRangeToInstants(params.created, params.tz),
    updated: dayRangeToInstants(params.updated, params.tz),
    window: { offset: paginated ? (params.page - 1) * pageSize : 0, limit: pageSize },
  };
  // Concurrently: each is a handful of queries over its own tables, and the
  // page waits for the slowest anyway.
  const sections = await Promise.all(kinds.map((kind) => searchKind(kind, ctx)));
  return { ...result, status: "ok", sections };
}
