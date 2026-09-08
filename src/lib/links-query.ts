import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /links' querystring vocabulary (docs/ANCHORED_LINKS.md, "The management
// table") — the admin-table kit's eighth `*-query.ts`, and like /tags' the
// plainest kind: a link has no visibility axis of its own and no byline, so
// the six base params are the whole vocabulary. Row scoping is not a param
// here at all; src/app/links/page.tsx derives it from the viewer.
//
// **Fewer sort keys than columns, deliberately.** Passages and Targets are
// per-viewer values: a target the viewer may not read is omitted from the
// cell (the follow path's silent-omission rule), so the count and the list a
// row shows depend on who is looking. Nothing Postgres could `ORDER BY` — not
// a plain column, not a `_count`, not a view (a view has no viewer) — matches
// what the cell displays, and §16e's rule is that displayed and sorted never
// drift. /annotations' Quote column is the precedent for a display-only column
// on the kit. Everything that *is* sortable here is a plain column or a
// to-one relation: createdBy, createdAt, mintedAt, id, the soft-delete pair.
export type LinksSortKey = "createdBy" | "created" | "minted" | "id" | "deletedAt" | "deleted";

const SORT_KEYS: readonly LinksSortKey[] = ["createdBy", "created", "minted", "id", "deletedAt", "deleted"];

// Newest first, like /files: a link is written once (its parts are frozen at
// mint), so "what was shared recently" is the landing view anyone comes here
// for — there is no updatedAt for a link's life to be measured in.
export const DEFAULT_SORT: SortColumn<LinksSortKey>[] = [{ key: "created", dir: "desc" }];

export type LinksFilters = BaseFilters<LinksSortKey>;

function spec(prefs: TablePrefs): BaseFilterSpec<LinksSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseLinksFilters(searchParams: URLSearchParams, prefs: TablePrefs): LinksFilters {
  return parseBaseFilters(searchParams, spec(prefs));
}

// Deep-link-only filters (?user=, ?doc=, ?file=) round-trip through `extra`
// unchanged, the same convention as annotations-query.ts.
export function buildLinksQueryString(filters: LinksFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  return buildBaseQueryString(filters, extra, spec(prefs)).toString();
}
