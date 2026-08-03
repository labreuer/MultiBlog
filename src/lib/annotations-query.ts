import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type PageSize,
} from "@/lib/table-query";

// The doc-side sibling of comments-query.ts (PLAN.md §12j) — a much smaller
// option set than the blog side's, since there's no status/threadStatus to
// filter on (annotations are never moderated). Now that the five shared
// params live in table-query.ts (§16c), what's left here is only the sort
// keys and the default sort, which is the whole point of that split.

// "quote" is deliberately not a sort key — unlike every other column, it
// isn't a stored value (§12i: the annotated text is read from the doc's
// prose_json through the mark, computed per row at render time), so there's
// nothing a database ORDER BY could sort it by.
export type AnnotationsSortKey = "doc" | "author" | "created" | "edited" | "deleted";
const SORT_KEYS: readonly AnnotationsSortKey[] = ["doc", "author", "created", "edited", "deleted"];
export const DEFAULT_SORT: SortColumn<AnnotationsSortKey>[] = [{ key: "created", dir: "desc" }];

export type AnnotationsFilters = BaseFilters<AnnotationsSortKey>;

function spec(defaultPageSize: PageSize): BaseFilterSpec<AnnotationsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, defaultPageSize };
}

export function parseAnnotationsFilters(
  searchParams: URLSearchParams,
  defaultPageSize: PageSize,
): AnnotationsFilters {
  return parseBaseFilters(searchParams, spec(defaultPageSize));
}

// Deep-link-only filters (?doc=, ?author=, ?user=) round-trip through the
// URL unchanged, same convention as comments-query.ts.
export function buildAnnotationsQueryString(
  filters: AnnotationsFilters,
  extra: URLSearchParams,
  defaultPageSize: PageSize,
): string {
  return buildBaseQueryString(filters, extra, spec(defaultPageSize)).toString();
}
