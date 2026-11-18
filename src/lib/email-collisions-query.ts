import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /email-collisions' querystring vocabulary (docs/COMMENTS.md, "The log"),
// shared by the page, which turns it into a Prisma query, and
// EmailCollisionsTable, which serializes changes back into a URL.
//
// `reviewed=1` is this table's counterpart to the kit's show-deleted toggle:
// unreviewed rows by default, every row with it. The kit's own `deleted`
// param is parsed and ignored, since a collision row is never deleted.
//
// Every column sorts: the row's own columns and its to-one relations through
// Prisma, and the anonymous identity's comment count and the three IP
// address lists through the `email_collision_listing` view.
export type EmailCollisionsSortKey =
  | "lastSeen"
  | "count"
  | "source"
  | "email"
  | "account"
  | "anonymous"
  | "anonymousComments"
  | "requestIps"
  | "anonymousIps"
  | "accountIps"
  | "post"
  | "firstSeen"
  | "reviewedAt"
  | "reviewedBy";
const SORT_KEYS: readonly EmailCollisionsSortKey[] = [
  "lastSeen",
  "count",
  "source",
  "email",
  "account",
  "anonymous",
  "anonymousComments",
  "requestIps",
  "anonymousIps",
  "accountIps",
  "post",
  "firstSeen",
  "reviewedAt",
  "reviewedBy",
];
export const DEFAULT_SORT: SortColumn<EmailCollisionsSortKey>[] = [{ key: "lastSeen", dir: "desc" }];

export type EmailCollisionsFilters = BaseFilters<EmailCollisionsSortKey> & { reviewed: boolean };

function spec(prefs: TablePrefs): BaseFilterSpec<EmailCollisionsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseEmailCollisionsFilters(searchParams: URLSearchParams, prefs: TablePrefs): EmailCollisionsFilters {
  return { ...parseBaseFilters(searchParams, spec(prefs)), reviewed: searchParams.get("reviewed") === "1" };
}

export function buildEmailCollisionsQueryString(
  filters: EmailCollisionsFilters,
  extra: URLSearchParams,
  prefs: TablePrefs,
): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("reviewed");
  if (filters.reviewed) params.set("reviewed", "1");
  return params.toString();
}
