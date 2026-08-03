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

// Four of /posts' nine columns are deliberately absent from this list, and
// stay display-only (§16e) — each is derived from a to-many relation, which
// Prisma has no `orderBy` for:
//
//   Author(s)          joined adminInitials across PostAuthor
//   Comments           approved/pending counts nested through threads, by status
//   Last edit by / at  the *latest* PublicationEvent, not an aggregate
//
// "events" survives because it's a plain relation count (_count), which
// Prisma does order by. Same trade-off /comments already made for its
// commenter-activity column.
export type PostsSortKey = "title" | "published" | "events" | "created" | "deleted";
const SORT_KEYS: readonly PostsSortKey[] = ["title", "published", "events", "created", "deleted"];
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
