import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  parseSetParam,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /join-codes' querystring vocabulary (docs/EMAIL.md §10, "Minting and
// printing"), shared by the page, which turns it into a Prisma query, and
// JoinCodesTable, which serializes changes back into a URL.
//
// One row per card. `batch=<id>` narrows the table to one batch, which is
// also what puts that batch's Print and Revoke in front of the ADMIN;
// `status` is a comma-separated subset of JOIN_CODE_STATUSES. A card is
// never deleted, so the kit's own `deleted` param is parsed and ignored.
//
// Every column sorts: the card's own columns and its batch's through Prisma,
// and its status through the `join_code_listing` view, in the order
// JOIN_CODE_STATUSES lists them.

/** A card's status as the `join_code_listing` view writes it, in its sort order. */
export const JOIN_CODE_STATUSES = ["unclaimed", "pending", "sends-used", "claimed", "expired", "revoked"] as const;
export type JoinCodeStatus = (typeof JOIN_CODE_STATUSES)[number];

export function isJoinCodeStatus(value: string): value is JoinCodeStatus {
  return (JOIN_CODE_STATUSES as readonly string[]).includes(value);
}

export type JoinCodesSortKey =
  | "batch"
  | "serial"
  | "status"
  | "pendingEmail"
  | "claimedBy"
  | "claimedAt"
  | "sends"
  | "lastSent"
  | "expires"
  | "minted";
const SORT_KEYS: readonly JoinCodesSortKey[] = [
  "batch",
  "serial",
  "status",
  "pendingEmail",
  "claimedBy",
  "claimedAt",
  "sends",
  "lastSent",
  "expires",
  "minted",
];
// The newest batch first, its cards in the order they were printed.
export const DEFAULT_SORT: SortColumn<JoinCodesSortKey>[] = [
  { key: "minted", dir: "desc" },
  { key: "serial", dir: "asc" },
];

export type JoinCodesFilters = BaseFilters<JoinCodesSortKey> & {
  /** One batch's id, or null for every batch. */
  batch: string | null;
  status: Set<JoinCodeStatus> | "ALL";
};

function spec(prefs: TablePrefs): BaseFilterSpec<JoinCodesSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseJoinCodesFilters(searchParams: URLSearchParams, prefs: TablePrefs): JoinCodesFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    batch: searchParams.get("batch") || null,
    status: parseSetParam(searchParams.get("status"), JOIN_CODE_STATUSES),
  };
}

export function buildJoinCodesQueryString(filters: JoinCodesFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("deleted");
  params.delete("batch");
  params.delete("status");
  if (filters.batch) params.set("batch", filters.batch);
  const status = filters.status;
  if (status !== "ALL") params.set("status", JOIN_CODE_STATUSES.filter((s) => status.has(s)).join(","));
  return params.toString();
}
