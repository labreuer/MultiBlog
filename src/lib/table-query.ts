import type { SortColumn, SortDirection } from "@/lib/table-sort";

// The querystring vocabulary every admin table shares (PLAN.md §16c), split
// out of comments-query.ts and annotations-query.ts, which had two copies of
// it before /posts, /docs and /users needed a third, fourth and fifth.
//
// Each table still owns its own `*-query.ts`: the pieces below are the five
// params they all have, and a table composes them with whatever else it
// filters on. Deliberately not a generic "filter descriptor" that returns a
// Record<string, unknown> — the multi-select params are typed sets of schema
// enums (CommentStatus, ThreadStatus), and erasing those types is exactly
// what would let a server-side `where` builder drift from what the table
// actually parses.

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// The default page size when a user has no usable preference stored — a
// floor, not the default: the real default is User.rowsPerPage (§16b), read
// per request and threaded in as `defaultPageSize` below.
export const FALLBACK_PAGE_SIZE: PageSize = 25;

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

// A stored User.rowsPerPage that isn't one of the four options (an older row,
// a hand-edited value) degrades to the fallback rather than being honoured —
// the dropdown can only ever show one of the four, and a page size with no
// matching option would render as a blank select.
export function coercePageSize(value: number): PageSize {
  return isPageSize(value) ? value : FALLBACK_PAGE_SIZE;
}

// The five params every admin table has. A table's own filter type extends
// this: `type PostsFilters = BaseFilters<PostsSortKey> & { … }`.
export type BaseFilters<K extends string> = {
  deleted: boolean;
  q: string;
  page: number;
  pageSize: PageSize;
  sort: SortColumn<K>[];
};

export type BaseFilterSpec<K extends string> = {
  sortKeys: readonly K[];
  defaultSort: SortColumn<K>[];
  // This user's stored preference (§16b). Both halves need it: parsing, to
  // fill in an absent ?pageSize=, and serializing, to know which value is
  // redundant enough to leave out of the URL.
  defaultPageSize: PageSize;
};

// Selection is either "every option" (the ALL checkbox, the default — no
// querystring param) or an explicit subset. Unchecking every individual
// option snaps back to ALL rather than leaving an unusable empty selection.
export function parseSetParam<T extends string>(value: string | null, all: readonly T[]): Set<T> | "ALL" {
  if (!value) return "ALL";
  const parts = value.split(",").filter((p): p is T => (all as readonly string[]).includes(p as T));
  return parts.length > 0 ? new Set(parts) : "ALL";
}

function parsePageSizeParam(value: string | null, defaultPageSize: PageSize): PageSize {
  const n = Number(value);
  return isPageSize(n) ? n : defaultPageSize;
}

function parsePageParam(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseSortParam<K extends string>(
  value: string | null,
  sortKeys: readonly K[],
  defaultSort: SortColumn<K>[],
): SortColumn<K>[] {
  if (!value) return defaultSort;
  const columns: SortColumn<K>[] = [];
  for (const part of value.split(",")) {
    const [key, dir] = part.split(":");
    if (!sortKeys.includes(key as K)) continue;
    if (dir !== "asc" && dir !== "desc") continue;
    columns.push({ key: key as K, dir: dir as SortDirection });
  }
  return columns.length > 0 ? columns : defaultSort;
}

export function parseBaseFilters<K extends string>(
  searchParams: URLSearchParams,
  spec: BaseFilterSpec<K>,
): BaseFilters<K> {
  return {
    deleted: searchParams.get("deleted") === "1",
    q: searchParams.get("q") ?? "",
    page: parsePageParam(searchParams.get("page")),
    pageSize: parsePageSizeParam(searchParams.get("pageSize"), spec.defaultPageSize),
    sort: parseSortParam(searchParams.get("sort"), spec.sortKeys, spec.defaultSort),
  };
}

// Returns URLSearchParams rather than a string so a caller can set its own
// params (a table's multi-selects) on the result before serializing. Params
// this doesn't know about — the deep-link-only filters (?post=, ?author=,
// ?commenter=, ?doc=, ?user=) — round-trip through `extra` untouched, which
// is what keeps a deep link alive across a sort or page change.
export function buildBaseQueryString<K extends string>(
  filters: BaseFilters<K>,
  extra: URLSearchParams,
  spec: BaseFilterSpec<K>,
): URLSearchParams {
  const params = new URLSearchParams(extra);
  params.delete("deleted");
  params.delete("q");
  params.delete("page");
  params.delete("pageSize");
  params.delete("sort");

  if (filters.deleted) params.set("deleted", "1");
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.page !== 1) params.set("page", String(filters.page));
  // Omitted when it matches this user's own preference, not a constant — an
  // absent ?pageSize= means "whatever my preference is", so the same link
  // gives two admins their own page sizes (§16b).
  if (filters.pageSize !== spec.defaultPageSize) params.set("pageSize", String(filters.pageSize));
  const sortIsDefault =
    filters.sort.length === spec.defaultSort.length &&
    filters.sort.every((c, i) => c.key === spec.defaultSort[i].key && c.dir === spec.defaultSort[i].dir);
  if (!sortIsDefault) params.set("sort", filters.sort.map((c) => `${c.key}:${c.dir}`).join(","));

  return params;
}

// Every admin page reads its searchParams the same way: Next hands them over
// as string | string[] | undefined, and a repeated param (?q=a&q=b) takes its
// first value rather than being rejected.
export function toURLSearchParams(resolved: Record<string, string | string[] | undefined>): URLSearchParams {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string") flat[key] = value;
    else if (Array.isArray(value) && value.length > 0) flat[key] = value[0];
  }
  return new URLSearchParams(flat);
}
