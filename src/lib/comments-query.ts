import type { CommentStatus, ThreadStatus } from "@/generated/prisma/enums";
import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  parseSetParam,
  type BaseFilterSpec,
  type BaseFilters,
  type PageSize,
} from "@/lib/table-query";

// Shared between src/app/comments/page.tsx (parses searchParams into a
// Prisma query) and CommentsTable.tsx (parses the same searchParams for
// display, and serializes filter/sort/page changes back into a URL) so the
// two can't drift on what a given querystring shape means.
//
// The five params every admin table has live in table-query.ts (PLAN.md
// §16c); what's here is what's specific to comment moderation — the two
// multi-selects, the sort keys, and the default sort.

export const STATUS_OPTIONS: CommentStatus[] = ["PENDING", "APPROVED", "SPAM"];
export const THREAD_STATUS_OPTIONS: ThreadStatus[] = ["ACTIVE", "DETACHED", "RESOLVED"];

// "counts" (the commenter-activity column) is deliberately not here — it's a
// per-commenter aggregate over comments outside the current filter, not a
// plain column, so sorting by it server-side would need a correlated
// subquery per row rather than a plain `orderBy`. Left display-only for now.
export type CommentsSortKey = "post" | "commenter" | "status" | "threadStatus" | "created" | "statusChanged" | "deleted";
const SORT_KEYS: readonly CommentsSortKey[] = [
  "post",
  "commenter",
  "status",
  "threadStatus",
  "created",
  "statusChanged",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<CommentsSortKey>[] = [{ key: "created", dir: "desc" }];

export type CommentsFilters = BaseFilters<CommentsSortKey> & {
  status: Set<CommentStatus> | "ALL";
  threadStatus: Set<ThreadStatus> | "ALL";
};

function spec(defaultPageSize: PageSize): BaseFilterSpec<CommentsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, defaultPageSize };
}

export function parseCommentsFilters(searchParams: URLSearchParams, defaultPageSize: PageSize): CommentsFilters {
  return {
    ...parseBaseFilters(searchParams, spec(defaultPageSize)),
    status: parseSetParam(searchParams.get("status"), STATUS_OPTIONS),
    threadStatus: parseSetParam(searchParams.get("threadStatus"), THREAD_STATUS_OPTIONS),
  };
}

// Deep-link-only filters (post/author/commenter) round-trip through the URL
// unchanged rather than through CommentsFilters — the table has no controls
// for them yet (see the page's Help section), so there's nothing to
// serialize back out; the server only ever reads them.
export function buildCommentsQueryString(
  filters: CommentsFilters,
  extra: URLSearchParams,
  defaultPageSize: PageSize,
): string {
  const params = buildBaseQueryString(filters, extra, spec(defaultPageSize));
  params.delete("status");
  params.delete("threadStatus");

  if (filters.status !== "ALL") params.set("status", [...filters.status].join(","));
  if (filters.threadStatus !== "ALL") params.set("threadStatus", [...filters.threadStatus].join(","));

  return params.toString();
}
