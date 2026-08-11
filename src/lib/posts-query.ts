import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseAuthorMode,
  parseBaseFilters,
  parseSlugListParam,
  DEFAULT_AUTHOR_MODE,
  type AuthorMode,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /posts' querystring vocabulary (PLAN.md §16e), the same split every admin
// table now uses: the five shared params come from table-query.ts, the sort
// keys and default sort are this table's own.

// Every /posts column sorts (§16e/§16l). Three of them only because a database
// view gives Prisma a to-one relation to order through, each expressing
// something `orderBy` cannot reach on a to-many — which offers `_count` and
// nothing else:
//
//   editor/lastEdit  post_activity — an *argmax*, the actor and timestamp of
//                    the most recent publication event. "Last edit by" isn't
//                    even an aggregate, so no orderBy extension short of raw
//                    SQL could have expressed it.
//   authors          post_metrics.byline — adminInitials string_agg'd across
//                    PostAuthor in byline order, i.e. the same string the
//                    cell prints.
//   comments         post_metrics.approved_count/pending_count — *filtered*
//                    counts (by status, excluding soft-deleted comments),
//                    which `_count` cannot express even though it counts.
//
// "events" needs no view: a plain relation count is exactly what `_count`
// orders by.
//
// slug/moderationPolicy/deletedAt are plain Post columns, defaulted hidden
// (§16l): available for anyone who wants them, without cluttering the table
// every load. `deletedAt` is the raw timestamp, distinct from `deleted`'s
// existing live/deleted-status sort.
export type PostsSortKey =
  | "title"
  | "authors"
  | "published"
  | "comments"
  | "events"
  | "editor"
  | "lastEdit"
  | "created"
  | "slug"
  | "moderationPolicy"
  | "deletedAt"
  | "deleted";
const SORT_KEYS: readonly PostsSortKey[] = [
  "title",
  "authors",
  "published",
  "comments",
  "events",
  "editor",
  "lastEdit",
  "created",
  "slug",
  "moderationPolicy",
  "deletedAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<PostsSortKey>[] = [{ key: "created", dir: "desc" }];

// The Authors filter (src/lib/author-filter.ts) — /posts' first table-specific
// params, following the same shape /docs' showAllDocs already established.
export type PostsFilters = BaseFilters<PostsSortKey> & {
  authors: string[];
  authorMode: AuthorMode;
};

function spec(prefs: TablePrefs): BaseFilterSpec<PostsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

// `knownAuthorSlugs` is the server-fetched allowlist (listAuthorFilterOptions
// mapped to slugs) — a slug in the URL that isn't in it is dropped rather
// than honoured (parseSlugListParam, table-query.ts).
export function parsePostsFilters(
  searchParams: URLSearchParams,
  prefs: TablePrefs,
  knownAuthorSlugs: readonly string[],
): PostsFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    authors: parseSlugListParam(searchParams.get("authors"), knownAuthorSlugs),
    authorMode: parseAuthorMode(searchParams.get("authorMode")),
  };
}

export function buildPostsQueryString(filters: PostsFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("authors");
  params.delete("authorMode");
  if (filters.authors.length > 0) params.set("authors", filters.authors.join(","));
  if (filters.authorMode !== DEFAULT_AUTHOR_MODE) params.set("authorMode", filters.authorMode);
  return params.toString();
}
