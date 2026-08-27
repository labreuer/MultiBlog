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

// /docs' querystring vocabulary (PLAN.md §16e).

// Three of these keys name something no plain `ORDER BY` on `doc` could, and
// they get there by different routes — worth keeping straight:
//
//   authors      `doc_metrics.byline` — adminInitials string_agg'd across
//                DocAuthor in byline order. A to-many Prisma could otherwise
//                only `_count`, so it needs the view to become a to-one
//                relation.
//   annotations  `doc_metrics.annotation_count` — a *filtered* count
//                (non-deleted, non-DRAFT, replies included), which `_count`
//                has no way to express in an orderBy. Deliberately the twin
//                of /files' annotations key (src/lib/files-query.ts), down to
//                the filter, so the two tables count the same thing.
//   length       `Doc.proseJsonLength` — a stored column, kept current by
//                the doc_sync_prose_json_length trigger, rather than a view
//                column: doc_length is a recursive walk over the whole body
//                and a view recomputes per query, so sorting through one
//                would walk every doc in the table on every page load.
//                Storing it makes that one walk per collab flush instead
//                (PLAN.md §16l).
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
  | "annotations"
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
  "annotations",
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
  // The Authors filter (src/lib/author-filter.ts) — slugs, sanitized against
  // whatever listAuthorFilterOptions returned for this request, and how they
  // combine. Empty `authors` means no filter, whatever `authorMode` says.
  authors: string[];
  authorMode: AuthorMode;
};

function spec(prefs: TablePrefs): BaseFilterSpec<DocsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

// `knownAuthorSlugs` is the server-fetched allowlist (listAuthorFilterOptions
// mapped to slugs) — a slug in the URL that isn't in it is dropped rather
// than honoured (parseSlugListParam, table-query.ts).
export function parseDocsFilters(
  searchParams: URLSearchParams,
  prefs: TablePrefs,
  knownAuthorSlugs: readonly string[],
): DocsFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    showAllDocs: searchParams.get("showAllDocs") === "1",
    authors: parseSlugListParam(searchParams.get("authors"), knownAuthorSlugs),
    authorMode: parseAuthorMode(searchParams.get("authorMode")),
  };
}

export function buildDocsQueryString(filters: DocsFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("showAllDocs");
  if (filters.showAllDocs) params.set("showAllDocs", "1");
  params.delete("authors");
  params.delete("authorMode");
  if (filters.authors.length > 0) params.set("authors", filters.authors.join(","));
  if (filters.authorMode !== DEFAULT_AUTHOR_MODE) params.set("authorMode", filters.authorMode);
  return params.toString();
}
