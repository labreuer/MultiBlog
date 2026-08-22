import type { Role } from "@/generated/prisma/enums";

// Pure role checks, split out of authz.ts specifically so they're safe to
// import from client components (useSession()-based UI, e.g. SiteHeader,
// PostEditBadge). authz.ts also exports canUserEditPost, which imports
// prisma — importing that into a client bundle would try to bundle
// PrismaClient into the browser.

export const POST_MANAGER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR"];

export function canManagePosts(role: Role): boolean {
  return POST_MANAGER_ROLES.includes(role);
}

export function canEditAnyPost(role: Role): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

export function isAdmin(role: Role): boolean {
  return role === "ADMIN";
}

// PLAN.md §12e — governs reading and annotating a SHARED doc, not /docs
// management (that's DOC_MANAGER_ROLES/canManageDocs below).
export const DOC_VIEWER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR", "AUTHORIZED"];

export function canViewDocs(role: Role): boolean {
  return DOC_VIEWER_ROLES.includes(role);
}

// /docs management keeps the same role set as post management — AUTHORIZED
// grants reading/annotating docs, not creating/managing them.
export const DOC_MANAGER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR"];

export function canManageDocs(role: Role): boolean {
  return DOC_MANAGER_ROLES.includes(role);
}

// PLAN.md §19 — the file counterparts, governing /pdf/[slug] reading and
// /files management. Same role sets as the doc pair above, stated
// independently and **deliberately not delegating to them**, which is the same
// decision (and the same reasoning) as canManageDocs vs. canManagePosts: a
// delegation preserves exactly the coupling the separation exists to break, so
// that changing who may read a doc would silently change who may read a PDF.
// If the two should ever differ, these are the functions to change.
//
// Both are here rather than in file-authz.ts by this file's own rule — a
// client consumer is what earns the place, and SiteHeader needs canManageFiles
// for the Files link.
export const FILE_VIEWER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR", "AUTHORIZED"];

export function canViewFiles(role: Role): boolean {
  return FILE_VIEWER_ROLES.includes(role);
}

export const FILE_MANAGER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR"];

export function canManageFiles(role: Role): boolean {
  return FILE_MANAGER_ROLES.includes(role);
}

// Who may carry a byline on a doc or post — the option list for the /docs and
// /posts Authors filter (src/lib/author-filter.ts), and what the two edit
// pages already hardcode inline when deciding who's eligible to be added as a
// co-author. Coincides with DOC_MANAGER_ROLES/POST_MANAGER_ROLES today, and is
// named separately because it answers a different question: what a byline may
// *name*, not who may *manage*. /files' Owner(s) filter shares the list: being
// eligible to be listed on a row is the same question whether the row credits
// the user (a doc, a post) or belongs to them (a file, PLAN.md §19).
export const BYLINE_ELIGIBLE_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR"];

// canEditAnySharedDoc is deliberately *not* here, though it is just as pure a
// role check as these. What earns a place in this file is a client consumer:
// the two doc predicates above are here because SiteHeader needs them, not
// because they concern docs. Nothing in the browser asks who may edit a
// SHARED doc without a byline, so that one lives beside the rest of the doc
// authorization rules in doc-authz.ts instead.
