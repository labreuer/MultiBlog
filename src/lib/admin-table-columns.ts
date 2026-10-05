import type { AdminTableName } from "@/lib/column-order";

// Each admin table's movable (non-`alwaysVisible`) columns as plain data: key,
// header label, whether it is hidden by default, and their order. **This is the
// only place those four things are declared.** Each table component builds its
// movable ColumnSpecs from its list here through `registryColumns`
// (src/components/table/column-spec.ts), supplying only what a column *does*
// (sort key, cell, cell props), keyed by these keys — and the compiler holds the
// two together both ways: a key here with no cell, or a cell for a key not
// here, does not typecheck.
//
// Plain data because the site-settings page (PLAN.md §16i) needs column
// identity without the live ColumnSpecs: it edits `SiteSettings.
// defaultColumnOrder` for a table nobody has opened, and a table's ColumnSpecs
// are closures over that client component's hooks and state. Don't let a
// table declare any of the four again itself: two hand-kept copies drifted in
// six of the eight tables, and a key that differs is a column a saved site
// default silently hides.
export type ColumnMeta = { key: string; label: string; defaultHidden?: boolean };

export const ADMIN_TABLE_COLUMNS = {
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
    { key: "updatedAt", label: "Updated" },
    { key: "updatedBy", label: "Updated by" },
    { key: "length", label: "Length" },
    { key: "annotations", label: "Annotations", defaultHidden: true },
    { key: "slug", label: "Slug", defaultHidden: true },
    { key: "created", label: "Created", defaultHidden: true },
    { key: "createdBy", label: "Created by", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  files: [
    { key: "title", label: "Title (view)" },
    { key: "filename", label: "Filename (download)" },
    { key: "owners", label: "Owner(s)" },
    { key: "visibility", label: "Visibility" },
    { key: "pages", label: "Pages" },
    { key: "size", label: "Size" },
    { key: "annotations", label: "Annotations" },
    { key: "created", label: "Added" },
    { key: "createdBy", label: "Created by", defaultHidden: true },
    { key: "slug", label: "Slug", defaultHidden: true },
    { key: "updatedAt", label: "Updated", defaultHidden: true },
    { key: "updatedBy", label: "Updated by", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  users: [
    { key: "name", label: "Name" },
    { key: "email", label: "Email" },
    { key: "adminInitials", label: "Initials" },
    { key: "role", label: "Role" },
    { key: "image", label: "Image" },
    { key: "moderationPolicy", label: "Moderation policy" },
    { key: "rowsPerPage", label: "Rows/page", defaultHidden: true },
    { key: "color", label: "Color" },
    { key: "created", label: "Created at" },
    { key: "posts", label: "Posts" },
    { key: "comments", label: "Comments", defaultHidden: true },
    { key: "url", label: "Slug", defaultHidden: true },
    // Landing-page contributor fields (PLAN.md §17i), all defaulted hidden
    // per §16m so no existing admin's table silently widens by five columns.
    // contributorBlurb carries no sortKey — see UsersTable.tsx's column def.
    { key: "isListedContributor", label: "Listed contributor", defaultHidden: true },
    { key: "contributorOrder", label: "Contributor order", defaultHidden: true },
    { key: "contributorBlurb", label: "Contributor blurb", defaultHidden: true },
    { key: "orcid", label: "ORCID iD", defaultHidden: true },
    { key: "website", label: "Website", defaultHidden: true },
    // Invites (docs/EMAIL.md), both defaulted hidden — same reasoning as the
    // contributor fields above.
    { key: "invite", label: "Send invite", defaultHidden: true },
    { key: "inviteUrl", label: "Invite URL", defaultHidden: true },
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
  // PLAN.md §20d. Six of these read the tag_metrics view; the four
  // per-type counts default hidden so an existing admin's table doesn't
  // silently widen by four columns (§16m) — Assignments is the one usage
  // number the landing view shows.
  tags: [
    { key: "name", label: "Name" },
    { key: "description", label: "Description" },
    { key: "assignments", label: "Assignments" },
    { key: "docs", label: "Docs", defaultHidden: true },
    { key: "posts", label: "Posts", defaultHidden: true },
    { key: "files", label: "Files", defaultHidden: true },
    { key: "annotations", label: "Annotations", defaultHidden: true },
    { key: "lastUsed", label: "Last used" },
    { key: "createdBy", label: "Created by" },
    { key: "created", label: "Created at" },
    { key: "slug", label: "Slug", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
  ],
  annotations: [
    { key: "doc", label: "Doc / File" },
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
  // docs/ANCHORED_LINKS.md — /links. Name is the creator-given one, blank
  // for most links and editable in place where the viewer may rename.
  // Passages and Targets are per-viewer (unreadable targets omitted, like
  // the follow path) and so carry no sortKey; Id is the raw cuid, hidden by
  // default since Passages already links to the landing route.
  links: [
    { key: "name", label: "Name" },
    { key: "passages", label: "Passages" },
    { key: "targets", label: "Targets" },
    { key: "createdBy", label: "Created by" },
    { key: "created", label: "Created at" },
    { key: "minted", label: "Minted at" },
    { key: "edited", label: "Edited at", defaultHidden: true },
    { key: "id", label: "Id", defaultHidden: true },
    { key: "deletedAt", label: "Deleted at", defaultHidden: true },
    { key: "edit", label: "Edit" },
  ],
} as const satisfies Record<AdminTableName, readonly ColumnMeta[]>;

/** The movable column keys of one admin table — what its `registryColumns` call must supply a body for. */
export type AdminColumnKey<T extends AdminTableName> = (typeof ADMIN_TABLE_COLUMNS)[T][number]["key"];

/** One table's list, widened to `ColumnMeta` so callers can read `defaultHidden` on every entry. */
export function adminTableColumns(table: AdminTableName): readonly ColumnMeta[] {
  return ADMIN_TABLE_COLUMNS[table];
}

/**
 * The effective default column set for a table when no site override exists —
 * every column except the ones defaulted hidden, in the order above. The same
 * rule as `defaultColumnKeys` in column-spec.ts, which applies it to the live
 * ColumnSpecs built from these same entries, so the two agree by construction.
 */
export function codeDefaultColumns(table: AdminTableName): string[] {
  return adminTableColumns(table)
    .filter((column) => !column.defaultHidden)
    .map((column) => column.key);
}
