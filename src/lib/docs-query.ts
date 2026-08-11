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
// slug/created/deletedAt are plain Doc columns, defaulted hidden (§16l) —
// available without cluttering the default view. updatedAt is shown (and
// sorted) by default instead of created: "what changed recently" is a more
// useful landing view for this table than "what was made first" (PLAN.md
// admin-tables rework).
export type DocsSortKey =
  | "title"
  | "authors"
  | "visibility"
  | "created"
  | "length"
  | "slug"
  | "updatedAt"
  | "updatedBy"
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
  "updatedBy",
  "deletedAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<DocsSortKey>[] = [{ key: "updatedAt", dir: "desc" }];

// showAllDocs (docs/PERMISSIONS.md) — an ADMIN-only opt-in that widens the listing
// to every doc, including PRIVATE ones this user has no byline on. Parsed
// unconditionally here, like any other filter; src/app/docs/page.tsx is where
// the signed-in user's role is checked before it counts for anything, so a
// non-admin appending ?showAllDocs=1 by hand gets the ordinary scoped
// listing. It lives here rather than in the shared BaseFilters
// (table-query.ts) because /docs is the only admin table whose rows carry an
// authorship model at all.
export type DocsFilters = BaseFilters<DocsSortKey> & {
  showAllDocs: boolean;
};

function spec(prefs: TablePrefs): BaseFilterSpec<DocsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseDocsFilters(searchParams: URLSearchParams, prefs: TablePrefs): DocsFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    showAllDocs: searchParams.get("showAllDocs") === "1",
  };
}

export function buildDocsQueryString(filters: DocsFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("showAllDocs");
  if (filters.showAllDocs) params.set("showAllDocs", "1");
  return params.toString();
}
