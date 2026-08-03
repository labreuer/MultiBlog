import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type PageSize,
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
export type PostsSortKey =
  | "title"
  | "authors"
  | "published"
  | "comments"
  | "events"
  | "editor"
  | "lastEdit"
  | "created"
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
  "deleted",
];
export const DEFAULT_SORT: SortColumn<PostsSortKey>[] = [{ key: "created", dir: "desc" }];

export type PostsFilters = BaseFilters<PostsSortKey>;

function spec(defaultPageSize: PageSize): BaseFilterSpec<PostsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, defaultPageSize };
}

export function parsePostsFilters(searchParams: URLSearchParams, defaultPageSize: PageSize): PostsFilters {
  return parseBaseFilters(searchParams, spec(defaultPageSize));
}

export function buildPostsQueryString(
  filters: PostsFilters,
  extra: URLSearchParams,
  defaultPageSize: PageSize,
): string {
  return buildBaseQueryString(filters, extra, spec(defaultPageSize)).toString();
}
