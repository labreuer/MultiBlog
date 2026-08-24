import type { SortColumn } from "@/lib/table-sort";
import {
  buildBaseQueryString,
  parseAuthorMode,
  parseBaseFilters,
  parseSlugListParam,
  DEFAULT_AUTHOR_MODE,
  type AuthorMode,
  type BaseFilterSpec,
  type BaseFilters,
  type TablePrefs,
} from "@/lib/table-query";

// /files' querystring vocabulary (PLAN.md §19) — the doc equivalent is
// src/lib/docs-query.ts, and this is deliberately its twin so the two admin
// tables behave identically where they behave at all.
//
// Only one key here can't be reached by a plain `ORDER BY` on `file`:
//
//   owners       `file_metrics.owners` — admin_initials string_agg'd across
//                FileOwner in owner order, a to-many Prisma could otherwise
//                only `_count`. Named for ownership rather than authorship
//                because nobody listed on a file wrote it (schema.prisma's
//                FileOwner); /docs' and /posts' equivalent stays `authors`.
//   annotations  `file_metrics.annotation_count` — a *filtered* count
//                (non-deleted, non-DRAFT), which `_count` has no way to
//                express in an orderBy.
//
// Size and Pages are plain stored columns and need neither a view nor a
// trigger, which is the difference from /docs' Length: a doc's length is a
// recursive walk over its body that changes on every edit, where a file's byte
// count and page count are known once at upload and never again (schema.prisma,
// PLAN.md §16l for why that distinction decides between a view and a column).
export type FilesSortKey =
  | "title"
  | "filename"
  | "owners"
  | "visibility"
  | "pages"
  | "size"
  | "annotations"
  | "created"
  | "slug"
  | "updatedAt"
  | "updatedBy"
  | "deletedAt"
  | "deleted";

const SORT_KEYS: readonly FilesSortKey[] = [
  "title",
  "filename",
  "owners",
  "visibility",
  "pages",
  "size",
  "annotations",
  "created",
  "slug",
  "updatedAt",
  "updatedBy",
  "deletedAt",
  "deleted",
];

// "What was added recently" is the useful landing view for a file listing —
// unlike /docs, where updatedAt leads because a doc's whole life is edits. A
// file is written once; its updatedAt only moves when someone renames it or
// changes its visibility, which is not what anyone comes to this table for.
export const DEFAULT_SORT: SortColumn<FilesSortKey>[] = [{ key: "created", dir: "desc" }];

// showAllFiles — the ADMIN-only opt-in that widens the listing to every file,
// including PRIVATE ones this user does not own. Parsed unconditionally
// here, like any other filter; src/app/files/page.tsx is where the role is
// checked before it counts for anything, so a non-admin appending
// ?showAllFiles=1 by hand gets the ordinary scoped listing. Exactly the shape
// /docs' showAllDocs has, including that it widens this query and only this
// query — opening a PRIVATE file still goes through canUserReadFile.
//
// `ownerMode` is typed AuthorMode because the four combining modes are the
// admin-table kit's, shared verbatim with /docs and /posts — only the relation
// they combine over differs.
export type FilesFilters = BaseFilters<FilesSortKey> & {
  showAllFiles: boolean;
  owners: string[];
  ownerMode: AuthorMode;
};

function spec(prefs: TablePrefs): BaseFilterSpec<FilesSortKey> {
  return { sortKeys: SORT_KEYS, defaultSort: DEFAULT_SORT, prefs };
}

export function parseFilesFilters(
  searchParams: URLSearchParams,
  prefs: TablePrefs,
  knownOwnerSlugs: readonly string[],
): FilesFilters {
  return {
    ...parseBaseFilters(searchParams, spec(prefs)),
    showAllFiles: searchParams.get("showAllFiles") === "1",
    owners: parseSlugListParam(searchParams.get("owners"), knownOwnerSlugs),
    ownerMode: parseAuthorMode(searchParams.get("ownerMode")),
  };
}

export function buildFilesQueryString(filters: FilesFilters, extra: URLSearchParams, prefs: TablePrefs): string {
  const params = buildBaseQueryString(filters, extra, spec(prefs));
  params.delete("showAllFiles");
  if (filters.showAllFiles) params.set("showAllFiles", "1");
  params.delete("owners");
  params.delete("ownerMode");
  if (filters.owners.length > 0) params.set("owners", filters.owners.join(","));
  if (filters.ownerMode !== DEFAULT_AUTHOR_MODE) params.set("ownerMode", filters.ownerMode);
  return params.toString();
}
