import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /references' querystring vocabulary (docs/CITATIONS.md, "Pages"). As plain
// as /tags': a reference has no visibility and no per-viewer scoping, so the
// base params are the whole vocabulary.
//
// `people`, `year` and `title` are fields of the record's CSL-JSON, which a
// plain ORDER BY on `reference` can't name: they sort through the
// `reference_listing` view (PLAN.md §16e).
export type ReferencesSortKey = "key" | "short" | "people" | "year" | "title" | "file" | "created" | "createdBy" | "deletedAt" | "deleted";

const SORT_KEYS: readonly ReferencesSortKey[] = ["key", "short", "people", "year", "title", "file", "created", "createdBy", "deletedAt", "deleted"];

// By author, then year: the order a bibliography is read in, and the one in
// which a second copy of a work lands beside the first.
export const DEFAULT_SORT: SortColumn<ReferencesSortKey>[] = [
  { key: "people", dir: "asc" },
  { key: "year", dir: "asc" },
];

export type ReferencesFilters = BaseFilters<ReferencesSortKey>;

function spec(prefs: TablePrefs): BaseFilterSpec<ReferencesSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseReferencesFilters(searchParams: URLSearchParams, prefs: TablePrefs): ReferencesFilters {
  return parseBaseFilters(searchParams, spec(prefs));
}

export function buildReferencesQueryString(filters: ReferencesFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  return buildBaseQueryString(filters, extra, spec(prefs)).toString();
}
