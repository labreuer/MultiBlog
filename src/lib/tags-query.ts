import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseBaseFilters,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /tags' querystring vocabulary (PLAN.md §20d). The admin-table kit's
// sixth `*-query.ts`, and deliberately the plainest of them: a tag has no
// visibility axis, no byline, and no per-viewer scoping, so it needs none of
// the `showAll…`/`authors`/`authorMode` machinery /docs and /files carry. The
// six base params are the whole vocabulary.
//
// Six keys here can't be reached by a plain `ORDER BY` on `tag`, and all
// six go through the `tag_metrics` view (§16e, §16l):
//
//   assignments  `assignment_count` — distinct live acts of tagging. Not a
//                Prisma `_count`, because it is *filtered* (live assignments,
//                live targets) and `_count` has no way to say so in an orderBy —
//                the same reason file_metrics.annotation_count exists.
//   docs/posts/  the per-type object counts, each a `count(DISTINCT …)` over an
//   files/       arc column. A `_count` could not express these at all: they
//   annotations  count *distinct targets of one kind* across a to-many, not
//                rows.
//   lastUsed     `max(assigned_at)` — "when was this term last applied", which
//                is the column an editor actually sorts by to find dead
//                vocabulary.
//
// All six order with `nulls: "last"`, because an unused term has no view row
// and would otherwise lead a descending sort (src/app/tags/page.tsx).
//
// Everything else — name, slug, description, created, createdBy — is a plain
// column or a to-one relation Prisma can already order by.
export type TagsSortKey =
  | "name"
  | "description"
  | "assignments"
  | "docs"
  | "posts"
  | "files"
  | "annotations"
  | "lastUsed"
  | "createdBy"
  | "created"
  | "slug"
  | "deletedAt"
  | "deleted";

const SORT_KEYS: readonly TagsSortKey[] = [
  "name",
  "description",
  "assignments",
  "docs",
  "posts",
  "files",
  "annotations",
  "lastUsed",
  "createdBy",
  "created",
  "slug",
  "deletedAt",
  "deleted",
];

// Alphabetical, not "most used" and not "newest". A vocabulary is a *list you
// look things up in* before it is a feed — the landing view's job here is to
// let someone find whether a term already exists, which is the question that
// keeps a controlled vocabulary from sprouting near-duplicates. The usage
// columns are one click away and sort descending on the first click like every
// other numeric column in the kit.
export const DEFAULT_SORT: SortColumn<TagsSortKey>[] = [{ key: "name", dir: "asc" }];

export type TagsFilters = BaseFilters<TagsSortKey>;

function spec(prefs: TablePrefs): BaseFilterSpec<TagsSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseTagsFilters(searchParams: URLSearchParams, prefs: TablePrefs): TagsFilters {
  return parseBaseFilters(searchParams, spec(prefs));
}

export function buildTagsQueryString(filters: TagsFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  return buildBaseQueryString(filters, extra, spec(prefs)).toString();
}
