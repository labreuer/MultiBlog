import type { CommentStatus, ThreadStatus } from "@/generated/prisma/enums";
import type { SortColumn, SortDirection } from "@/lib/use-sortable-rows";

// Shared between src/app/comments/page.tsx (parses searchParams into a
// Prisma query) and CommentsTable.tsx (parses the same searchParams for
// display, and serializes filter/sort/page changes back into a URL) so the
// two can't drift on what a given querystring shape means.

export const STATUS_OPTIONS: CommentStatus[] = ["PENDING", "APPROVED", "SPAM"];
export const THREAD_STATUS_OPTIONS: ThreadStatus[] = ["ACTIVE", "DETACHED", "RESOLVED"];
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

// "counts" (the commenter-activity column) is deliberately not here — it's a
// per-commenter aggregate over comments outside the current filter, not a
// plain column, so sorting by it server-side would need a correlated
// subquery per row rather than a plain `orderBy`. Left display-only for now.
export type CommentsSortKey = "post" | "commenter" | "status" | "threadStatus" | "created" | "statusChanged";
const SORT_KEYS: readonly CommentsSortKey[] = ["post", "commenter", "status", "threadStatus", "created", "statusChanged"];
export const DEFAULT_SORT: SortColumn<CommentsSortKey>[] = [{ key: "created", dir: "desc" }];

export type CommentsFilters = {
  status: Set<CommentStatus> | "ALL";
  threadStatus: Set<ThreadStatus> | "ALL";
  deleted: boolean;
  q: string;
  page: number;
  pageSize: PageSize;
  sort: SortColumn<CommentsSortKey>[];
};

// Selection is either "every option" (the ALL checkbox, the default — no
// querystring param) or an explicit subset. Unchecking every individual
// option snaps back to ALL rather than leaving an unusable empty selection.
function parseSetParam<T extends string>(value: string | null, all: readonly T[]): Set<T> | "ALL" {
  if (!value) return "ALL";
  const parts = value.split(",").filter((p): p is T => (all as readonly string[]).includes(p as T));
  return parts.length > 0 ? new Set(parts) : "ALL";
}

function parsePageSizeParam(value: string | null): PageSize {
  const n = Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
}

function parsePageParam(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseSortParam(value: string | null): SortColumn<CommentsSortKey>[] {
  if (!value) return DEFAULT_SORT;
  const columns: SortColumn<CommentsSortKey>[] = [];
  for (const part of value.split(",")) {
    const [key, dir] = part.split(":");
    if (!SORT_KEYS.includes(key as CommentsSortKey)) continue;
    if (dir !== "asc" && dir !== "desc") continue;
    columns.push({ key: key as CommentsSortKey, dir: dir as SortDirection });
  }
  return columns.length > 0 ? columns : DEFAULT_SORT;
}

export function parseCommentsFilters(searchParams: URLSearchParams): CommentsFilters {
  return {
    status: parseSetParam(searchParams.get("status"), STATUS_OPTIONS),
    threadStatus: parseSetParam(searchParams.get("threadStatus"), THREAD_STATUS_OPTIONS),
    deleted: searchParams.get("deleted") === "1",
    q: searchParams.get("q") ?? "",
    page: parsePageParam(searchParams.get("page")),
    pageSize: parsePageSizeParam(searchParams.get("pageSize")),
    sort: parseSortParam(searchParams.get("sort")),
  };
}

// Deep-link-only filters (post/author/commenter) round-trip through the URL
// unchanged rather than through CommentsFilters — the table has no controls
// for them yet (see the page's Help section), so there's nothing to
// serialize back out; the server only ever reads them.
export function buildCommentsQueryString(filters: CommentsFilters, extra: URLSearchParams): string {
  const params = new URLSearchParams(extra);
  params.delete("status");
  params.delete("threadStatus");
  params.delete("deleted");
  params.delete("q");
  params.delete("page");
  params.delete("pageSize");
  params.delete("sort");

  if (filters.status !== "ALL") params.set("status", [...filters.status].join(","));
  if (filters.threadStatus !== "ALL") params.set("threadStatus", [...filters.threadStatus].join(","));
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
