import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /users' querystring vocabulary (PLAN.md §16e). Every column here is a
// plain User column or a plain relation count, so unlike /posts and /docs
// nothing had to become display-only on the move server-side.
//
// Sorting by role stays in privilege order without a lookup table: Postgres
// orders an enum by declaration order, and Role is declared ADMIN → EDITOR →
// AUTHOR → AUTHORIZED → COMMENTER, which is exactly what UsersTable's
// ROLE_ORDER constant spelled out while the sort was client-side.
// deletedAt is the one addition: a plain User column, defaulted hidden
// (§16l) — the raw timestamp behind the existing Deleted action column's
// boolean.
// isListedContributor/contributorOrder/orcid/website (PLAN.md §17i) are
// plain scalar User columns, so they sort the same way any other column
// here does. contributorBlurb is deliberately absent — it's Json, which
// Prisma's orderBy can't reach, and the view escape hatch (§16e/§16l) would
// need a SQL text-extraction function over TipTap JSON for an ordering
// nobody needs; see UsersTable.tsx's column def for the same rationale
// `image` already sets a precedent for (shown, not sorted).
export type UsersSortKey =
  | "name"
  | "email"
  | "adminInitials"
  | "role"
  | "moderationPolicy"
  | "rowsPerPage"
  | "posts"
  | "isListedContributor"
  | "contributorOrder"
  | "orcid"
  | "website"
  | "createdAt"
  | "deletedAt"
  | "deleted";
const SORT_KEYS: readonly UsersSortKey[] = [
  "name",
  "email",
  "adminInitials",
  "role",
  "moderationPolicy",
  "rowsPerPage",
  "posts",
  "isListedContributor",
  "contributorOrder",
  "orcid",
  "website",
  "createdAt",
  "deletedAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<UsersSortKey>[] = [{ key: "createdAt", dir: "desc" }];

export type UsersFilters = BaseFilters<UsersSortKey>;

function spec(prefs: TablePrefs): BaseFilterSpec<UsersSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseUsersFilters(searchParams: URLSearchParams, prefs: TablePrefs): UsersFilters {
  return parseBaseFilters(searchParams, spec(prefs));
}

export function buildUsersQueryString(
  filters: UsersFilters,
  extra: URLSearchParams,
  prefs: TablePrefs,
): string {
  return buildBaseQueryString(filters, extra, spec(prefs)).toString();
}
