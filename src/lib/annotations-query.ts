import type { SortColumn, SortDirection } from "@/lib/use-sortable-rows";

// The doc-side sibling of comments-query.ts (PLAN.md §12j) — a much smaller
// option set than the blog side's, since there's no status/threadStatus to
// filter on (annotations are never moderated). A shared parser would carry
// those permanently-inert options; kept separate for the same reason the
// underlying tables are.

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

// "quote" is deliberately not a sort key — unlike every other column, it
// isn't a stored value (§12i: the annotated text is read from the doc's
// prose_json through the mark, computed per row at render time), so there's
// nothing a database ORDER BY could sort it by.
export type AnnotationsSortKey = "doc" | "author" | "created" | "edited" | "deleted";
const SORT_KEYS: readonly AnnotationsSortKey[] = ["doc", "author", "created", "edited", "deleted"];
export const DEFAULT_SORT: SortColumn<AnnotationsSortKey>[] = [{ key: "created", dir: "desc" }];

export type AnnotationsFilters = {
  deleted: boolean;
  q: string;
  page: number;
  pageSize: PageSize;
  sort: SortColumn<AnnotationsSortKey>[];
};

function parsePageSizeParam(value: string | null): PageSize {
  const n = Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
}

function parsePageParam(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseSortParam(value: string | null): SortColumn<AnnotationsSortKey>[] {
  if (!value) return DEFAULT_SORT;
  const columns: SortColumn<AnnotationsSortKey>[] = [];
  for (const part of value.split(",")) {
    const [key, dir] = part.split(":");
    if (!SORT_KEYS.includes(key as AnnotationsSortKey)) continue;
    if (dir !== "asc" && dir !== "desc") continue;
    columns.push({ key: key as AnnotationsSortKey, dir: dir as SortDirection });
  }
  return columns.length > 0 ? columns : DEFAULT_SORT;
}

export function parseAnnotationsFilters(searchParams: URLSearchParams): AnnotationsFilters {
  return {
    deleted: searchParams.get("deleted") === "1",
    q: searchParams.get("q") ?? "",
    page: parsePageParam(searchParams.get("page")),
    pageSize: parsePageSizeParam(searchParams.get("pageSize")),
    sort: parseSortParam(searchParams.get("sort")),
  };
}

// Deep-link-only filters (?doc=, ?author=, ?user=) round-trip through the
// URL unchanged, same convention as comments-query.ts's buildCommentsQueryString.
export function buildAnnotationsQueryString(filters: AnnotationsFilters, extra: URLSearchParams): string {
  const params = new URLSearchParams(extra);
  params.delete("deleted");
  params.delete("q");
  params.delete("page");
  params.delete("pageSize");
  params.delete("sort");

  if (filters.deleted) params.set("deleted", "1");
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.page !== 1) params.set("page", String(filters.page));
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(filters.pageSize));
  const sortIsDefault =
    filters.sort.length === DEFAULT_SORT.length &&
    filters.sort.every((c, i) => c.key === DEFAULT_SORT[i].key && c.dir === DEFAULT_SORT[i].dir);
  if (!sortIsDefault) params.set("sort", filters.sort.map((c) => `${c.key}:${c.dir}`).join(","));

  return params.toString();
}
