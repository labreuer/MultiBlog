import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// The doc-side sibling of comments-query.ts (PLAN.md §12j) — a much smaller
// option set than the blog side's, since there's no status/threadStatus to
// filter on (annotations are never moderated). Now that the five shared
// params live in table-query.ts (§16c), what's left here is only the sort
// keys and the default sort, which is the whole point of that split.

// "quote" is deliberately not a sort key. It *is* a stored column now for a
// reading-view annotation and an anchored reply (§13o/§13p), but it still
// isn't for a mark-anchored one — that text is read from the doc's prose_json
// through the mark, per row at render time — so an ORDER BY would sort half
// the rows by their quote and the other half by an empty string, which is
// worse than not offering it.
// status/raisedAt/resolvedAt/deletedAt are plain Annotation columns.
// `status` (LIVE/RAISED — DRAFT is excluded from this whole page, §13d) is
// shown by default, since it names a real workflow state (RAISED means the
// doc's byline authors were emailed) that otherwise has no visibility
// anywhere in this table. raisedAt/resolvedAt/deletedAt are defaulted
// hidden (§16l).
export type AnnotationsSortKey =
  | "doc"
  | "author"
  | "created"
  | "edited"
  | "status"
  | "raisedAt"
  | "resolvedAt"
  | "deletedAt"
  | "deleted";
const SORT_KEYS: readonly AnnotationsSortKey[] = [
  "doc",
  "author",
  "created",
  "edited",
  "status",
  "raisedAt",
  "resolvedAt",
  "deletedAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<AnnotationsSortKey>[] = [{ key: "created", dir: "desc" }];

export type AnnotationsFilters = BaseFilters<AnnotationsSortKey>;

function spec(prefs: TablePrefs): BaseFilterSpec<AnnotationsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseAnnotationsFilters(
  searchParams: URLSearchParams,
  prefs: TablePrefs,
): AnnotationsFilters {
  return parseBaseFilters(searchParams, spec(prefs));
}

// Deep-link-only filters (?doc=, ?author=, ?user=) round-trip through the
// URL unchanged, same convention as comments-query.ts.
export function buildAnnotationsQueryString(
  filters: AnnotationsFilters,
  extra: URLSearchParams,
  prefs: TablePrefs,
): string {
  return buildBaseQueryString(filters, extra, spec(prefs)).toString();
}
