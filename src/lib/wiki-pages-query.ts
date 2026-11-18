import type { SortColumn } from "@/lib/table-sort";
import type { DocVisibility } from "@/generated/prisma/enums";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /wiki/special/pages' querystring vocabulary (docs/WIKI.md "Listing wiki
// pages"), the wiki's twin of docs-query.ts.
//
//   namespace   the owner's slug through the `wikiOwner` relation. A commons
//               page has no owner, so it sorts as a NULL relation would:
//               Postgres' default, after every person ascending and before
//               them descending. Prisma takes no `nulls` on a required
//               column reached through a relation, and putting the commons
//               first ascending would take a view keyed on the doc.
//   name        `wiki_name_key`, the folded key, so case doesn't order it.
//   variant     `wiki_variant`, "" (the page itself) first ascending.
//   authors     `doc_metrics.byline`, as /docs.
//   length      `Doc.proseJsonLength`, as /docs.
//   tags        `doc_tag_summary.names`, as /docs, and dropped under showAll
//               for the same reason: ordering by it would hint at the tags on
//               rows whose cells are withheld.
//   forkedFrom  the parent's id, not its title: a parent the viewer can't
//               read isn't named (docs/FORKS.md "Only what the viewer can
//               read is named"), and ordering by its title would place it
//               among the titles shown. By id, a page's siblings sit together
//               and pages that aren't forks come last either way.
export type WikiPagesSortKey =
  | "namespace"
  | "name"
  | "variant"
  | "visibility"
  | "authors"
  | "updatedAt"
  | "length"
  | "tags"
  | "forkedFrom"
  | "deletedAt"
  | "deleted";
const SORT_KEYS: readonly WikiPagesSortKey[] = [
  "namespace",
  "name",
  "variant",
  "visibility",
  "authors",
  "updatedAt",
  "length",
  "tags",
  "forkedFrom",
  "deletedAt",
  "deleted",
];
export const DEFAULT_SORT: SortColumn<WikiPagesSortKey>[] = [{ key: "updatedAt", dir: "desc" }];

/** The namespace filter: the commons, or a person's namespace by their slug. Null is every namespace. */
export type NamespaceFilter = { kind: "commons" } | { kind: "person"; slug: string } | null;

const VISIBILITIES: readonly DocVisibility[] = ["PRIVATE", "SHARED", "PUBLIC"];

// showAll is /docs' showAllDocs under this table's name: ADMIN-only, parsed
// unconditionally here and honoured only once the page has checked the role.
export type WikiPagesFilters = BaseFilters<WikiPagesSortKey> & {
  showAll: boolean;
  namespace: NamespaceFilter;
  visibility: DocVisibility | null;
};

/**
 * Whether the querystring asks for showAll. The page reads it before the rest
 * of the filters, since which namespaces the filter knows depends on which
 * rows are listed.
 */
export function parseShowAll(searchParams: URLSearchParams): boolean {
  return searchParams.get("showAll") === "1";
}

function spec(prefs: TablePrefs): BaseFilterSpec<WikiPagesSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

/**
 * `?namespace=commons`, or `?namespace=@<slug>` (a bare `<slug>` is read the
 * same way), as the owner segment of an address writes it, so a person whose
 * slug is `commons` is still `@commons`. `knownOwnerSlugs` is the page's list
 * of owners with a page in this viewer's listing: a slug outside it is
 * dropped rather than honoured, as /docs drops an unknown author, so a stale
 * link widens back to every namespace instead of going blank.
 */
function parseNamespace(value: string | null, knownOwnerSlugs: readonly string[]): NamespaceFilter {
  if (!value) return null;
  if (value === "commons") return { kind: "commons" };
  const slug = value.startsWith("@") ? value.slice(1) : value;
  return knownOwnerSlugs.includes(slug) ? { kind: "person", slug } : null;
}

/** The namespace filter as its param writes it, and as the filter's select keys its options. */
export function namespaceParam(namespace: NamespaceFilter): string {
  if (namespace === null) return "";
  return namespace.kind === "commons" ? "commons" : `@${namespace.slug}`;
}

function parseVisibility(value: string | null): DocVisibility | null {
  return (VISIBILITIES as readonly string[]).includes(value ?? "") ? (value as DocVisibility) : null;
}

export function parseWikiPagesFilters(
  searchParams: URLSearchParams,
  prefs: TablePrefs,
  knownOwnerSlugs: readonly string[],
): WikiPagesFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    showAll: parseShowAll(searchParams),
    namespace: parseNamespace(searchParams.get("namespace"), knownOwnerSlugs),
    visibility: parseVisibility(searchParams.get("visibility")),
  };
}

export function buildWikiPagesQueryString(
  filters: WikiPagesFilters,
  extra: URLSearchParams,
  prefs: TablePrefs,
): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("showAll");
  params.delete("namespace");
  params.delete("visibility");
  if (filters.showAll) params.set("showAll", "1");
  if (filters.namespace !== null) params.set("namespace", namespaceParam(filters.namespace));
  if (filters.visibility !== null) params.set("visibility", filters.visibility);
  return params.toString();
}
