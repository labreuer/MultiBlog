import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type PageSize,
} from "@/lib/table-query";

// /docs' querystring vocabulary (PLAN.md §16e).

// Author(s) and Length are display-only (§16e): the first is joined
// adminInitials across DocAuthor (a to-many Prisma can't order by), the
// second is doc_length(prose_json) — a Postgres function computed per row in
// a second query, not a column any `orderBy` can name.
export type DocsSortKey = "title" | "visibility" | "created" | "deleted";
const SORT_KEYS: readonly DocsSortKey[] = ["title", "visibility", "created", "deleted"];
export const DEFAULT_SORT: SortColumn<DocsSortKey>[] = [{ key: "created", dir: "desc" }];

export type DocsFilters = BaseFilters<DocsSortKey>;

function spec(defaultPageSize: PageSize): BaseFilterSpec<DocsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, defaultPageSize };
}

export function parseDocsFilters(searchParams: URLSearchParams, defaultPageSize: PageSize): DocsFilters {
  return parseBaseFilters(searchParams, spec(defaultPageSize));
}

export function buildDocsQueryString(filters: DocsFilters, extra: URLSearchParams, defaultPageSize: PageSize): string {
  return buildBaseQueryString(filters, extra, spec(defaultPageSize)).toString();
}
