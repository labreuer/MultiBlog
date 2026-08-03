import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type PageSize,
} from "@/lib/table-query";

// /users' querystring vocabulary (PLAN.md §16e). Every column here is a
// plain User column or a plain relation count, so unlike /posts and /docs
// nothing had to become display-only on the move server-side.
//
// Sorting by role stays in privilege order without a lookup table: Postgres
// orders an enum by declaration order, and Role is declared ADMIN → EDITOR →
// AUTHOR → AUTHORIZED → COMMENTER, which is exactly what UsersTable's
// ROLE_ORDER constant spelled out while the sort was client-side.
export type UsersSortKey =
  | "name"
  | "email"
  | "adminInitials"
  | "role"
  | "moderationPolicy"
  | "rowsPerPage"
  | "posts"
  | "createdAt"
  | "deleted";
const SORT_KEYS: readonly UsersSortKey[] = [
  "name",
  "email",
  "adminInitials",
  "role",
  "moderationPolicy",
  "rowsPerPage",
  "posts",
  "createdAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<UsersSortKey>[] = [{ key: "createdAt", dir: "desc" }];

export type UsersFilters = BaseFilters<UsersSortKey>;

function spec(defaultPageSize: PageSize): BaseFilterSpec<UsersSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, defaultPageSize };
}

export function parseUsersFilters(searchParams: URLSearchParams, defaultPageSize: PageSize): UsersFilters {
  return parseBaseFilters(searchParams, spec(defaultPageSize));
}

export function buildUsersQueryString(
  filters: UsersFilters,
  extra: URLSearchParams,
  defaultPageSize: PageSize,
): string {
  return buildBaseQueryString(filters, extra, spec(defaultPageSize)).toString();
}
