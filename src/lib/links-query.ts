import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  parseSlugListParam,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /links' querystring vocabulary (docs/ANCHORED_LINKS.md, "The management
// table") — the admin-table kit's eighth `*-query.ts`. A link has no
// visibility axis of its own, so the six base params plus one of its own are
// the whole vocabulary: `owners`, who created it, under /files' name for the
// same control. Row scoping is not a param here at all; src/app/links/page.tsx
// derives it from the viewer.
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

// `owners` — creator slugs, /files' `?owners=` over `anchored_link.created_by`
// instead of a to-many owner table. **No `ownerMode` beside it, deliberately**:
// a link has exactly one creator today, so ALL and EXACTLY collapse into ANY
// and the Match select would be a control with one live setting. If links ever
// gain co-owners, the mode comes back with the relation, the /files way.
export type LinksFilters = BaseFilters<LinksSortKey> & {
  owners: string[];
};

function spec(prefs: TablePrefs): BaseFilterSpec<LinksSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

// `knownOwnerSlugs` is the server-fetched allowlist (the page's creator
// list); a slug outside it is dropped rather than honoured, as /files does.
export function parseLinksFilters(
  searchParams: URLSearchParams,
  prefs: TablePrefs,
  knownOwnerSlugs: readonly string[],
): LinksFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    owners: parseSlugListParam(searchParams.get("owners"), knownOwnerSlugs),
  };
}

// Deep-link-only filters (?user=, ?doc=, ?file=) round-trip through `extra`
// unchanged, the same convention as annotations-query.ts. `?user=` is the
// id-keyed twin of `owners` and stays: a deep link carries an id it already
// has, where the dropdown carries slugs a person can read.
export function buildLinksQueryString(filters: LinksFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("owners");
  if (filters.owners.length > 0) params.set("owners", filters.owners.join(","));
  return params.toString();
}
