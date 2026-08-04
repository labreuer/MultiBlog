import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /docs' querystring vocabulary (PLAN.md §16e).

// Two of these keys name something no plain `ORDER BY` on `doc` could, and
// they get there by different routes — worth keeping straight:
//
//   authors  `doc_metrics.byline` — adminInitials string_agg'd across
//            DocAuthor in byline order. A to-many Prisma could otherwise only
//            `_count`, so it needs the view to become a to-one relation.
//   length   `Doc.proseJsonLength` — a stored column, kept current by the
//            doc_sync_prose_json_length trigger, rather than a view column:
//            doc_length is a recursive walk over the whole body and a view
//            recomputes per query, so sorting through one would walk every doc
//            in the table on every page load. Storing it makes that one walk
//            per collab flush instead (PLAN.md §16l).
// slug/updatedAt/deletedAt are plain Doc columns, defaulted hidden (§16l) —
// available without cluttering the default view.
export type DocsSortKey =
  | "title"
  | "authors"
  | "visibility"
  | "created"
  | "length"
  | "slug"
  | "updatedAt"
  | "deletedAt"
  | "deleted";
const SORT_KEYS: readonly DocsSortKey[] = [
  "title",
  "authors",
  "visibility",
  "created",
  "length",
  "slug",
  "updatedAt",
  "deletedAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<DocsSortKey>[] = [{ key: "created", dir: "desc" }];

export type DocsFilters = BaseFilters<DocsSortKey>;

function spec(prefs: TablePrefs): BaseFilterSpec<DocsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseDocsFilters(searchParams: URLSearchParams, prefs: TablePrefs): DocsFilters {
  return parseBaseFilters(searchParams, spec(prefs));
}

export function buildDocsQueryString(filters: DocsFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  return buildBaseQueryString(filters, extra, spec(prefs)).toString();
}
