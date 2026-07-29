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
