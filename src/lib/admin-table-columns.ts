import type { AdminTableName } from "@/lib/column-order";

// A plain-data mirror of each table's movable (non-`alwaysVisible`) columns —
// key, a human label, and whether the code itself defaults it to hidden — for
// the one place that needs column identity without the live `ColumnSpec`
// declarations: the site-settings page (PLAN.md §16i), which edits
// `SiteSettings.defaultColumnOrder` for a table nobody has opened, so it has
// no `ColumnSpec[]` (a client component's closures over its own hooks/state)
// to read from.
//
// This is a real, unavoidable duplication — the alternative is a deeper
// refactor separating "column identity" from "cell renderer" across all five
// tables, out of scope here — so it is centralized in this one file rather
// than scattered, and each table's block below is ordered and worded to make
// a side-by-side diff against that table's own ColumnSpec easy. **Adding,
// removing or renaming a movable column means updating both.**
export type ColumnMeta = { key: string; label: string; defaultHidden?: boolean };

export const ADMIN_TABLE_COLUMNS: Record<AdminTableName, ColumnMeta[]> = {
  posts: [
    { key: "title", label: "Title" },
    { key: "authors", label: "Author(s)" },
    { key: "published", label: "Published" },
    { key: "comments", label: "Comments" },
    { key: "events", label: "History" },
    { key: "editor", label: "Last edit by" },
    { key: "lastEdit", label: "Last edit at" },
    { key: "created", label: "Created at" },
    { key: "slug", label: "Slug", defaultHidden: true },
    { key: "moderationPolicy", label: "Moderation policy", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  docs: [
    { key: "title", label: "Title" },
    { key: "edit", label: "Edit" },
    { key: "authors", label: "Author(s)" },
    { key: "visibility", label: "Visibility" },
    { key: "created", label: "Created" },
    { key: "length", label: "Length" },
    { key: "slug", label: "Slug", defaultHidden: true },
    { key: "updatedAt", label: "Updated", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  users: [
    { key: "name", label: "Name" },
    { key: "email", label: "Email" },
    { key: "adminInitials", label: "Initials" },
    { key: "role", label: "Role" },
    { key: "image", label: "Image" },
    { key: "moderationPolicy", label: "Moderation policy" },
    { key: "rowsPerPage", label: "Rows/page" },
    { key: "color", label: "Color" },
    { key: "created", label: "Created at" },
    { key: "posts", label: "Posts" },
    { key: "comments", label: "Comments" },
    { key: "url", label: "URL (slug link)" },
    // Landing-page contributor fields (PLAN.md §17i), all defaulted hidden
    // per §16m so no existing admin's table silently widens by five columns.
    // contributorBlurb carries no sortKey — see UsersTable.tsx's column def.
    { key: "isListedContributor", label: "Listed contributor", defaultHidden: true },
    { key: "contributorOrder", label: "Contributor order", defaultHidden: true },
    { key: "contributorBlurb", label: "Contributor blurb", defaultHidden: true },
    { key: "orcid", label: "ORCID iD", defaultHidden: true },
    { key: "website", label: "Website", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  comments: [
    { key: "post", label: "Post" },
    { key: "commenter", label: "Commenter" },
    { key: "comment", label: "Comment" },
    { key: "status", label: "Status" },
    { key: "threadStatus", label: "Thread" },
    { key: "created", label: "Created at" },
    { key: "statusChanged", label: "Changed at" },
    { key: "commenterActivity", label: "Commenter activity" },
    { key: "action", label: "Action" },
    { key: "ipAddress", label: "IP address", defaultHidden: true },
    { key: "statusChangedBy", label: "Changed by", defaultHidden: true },
    { key: "editedAt", label: "Edited at", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  annotations: [
    { key: "doc", label: "Doc" },
    { key: "author", label: "Author" },
    { key: "body", label: "Body" },
    { key: "quote", label: "Quote" },
    { key: "status", label: "Status" },
    { key: "created", label: "Created" },
    { key: "edited", label: "Edited" },
    { key: "deletedStatus", label: "Deleted" },
    { key: "raisedAt", label: "Raised at", defaultHidden: true },
    { key: "resolvedAt", label: "Resolved at", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
};

/**
 * The effective default column set for a table when no site override exists —
 * every column except the ones the code itself defaults to hidden, in the
 * order above. Mirrors `defaultColumnKeys` in column-spec.ts, which is the
 * live version of this same rule; kept as a separate small function rather
 * than shared code because that one operates on a live `ColumnSpec<Row>[]`
 * and this one on the static `ColumnMeta[]` above — different types, same
 * one-line rule.
 */
export function codeDefaultColumns(table: AdminTableName): string[] {
  return ADMIN_TABLE_COLUMNS[table].filter((column) => !column.defaultHidden).map((column) => column.key);
}
