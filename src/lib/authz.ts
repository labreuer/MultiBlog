import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/role-checks";

export { POST_MANAGER_ROLES, canManagePosts, canEditAnyPost, isAdmin } from "@/lib/role-checks";

export async function canUserEditPost(userId: string, role: Role, postId: string): Promise<boolean> {
  if (canEditAnyPost(role)) {
    return true;
  }
  if (role !== "AUTHOR") {
    return false;
  }
  const author = await prisma.postAuthor.findUnique({
    where: { postId_userId: { postId, userId } },
  });
  return !!author;
}

// The dashboard Settings tiers (docs/DASHBOARD.md "Settings"). Coincides
// with BYLINE_ELIGIBLE_ROLES; stated independently per role-checks.ts's
// non-delegation convention.
export const AUTHOR_IDENTITY_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR"];

export function canEditAuthorIdentity(role: Role): boolean {
  return AUTHOR_IDENTITY_ROLES.includes(role);
}

// EDITOR+ additionally sees the dashboard's author-color roster — a view,
// not a permission to change anyone else's. Same non-delegation reason.
export const COLOR_ROSTER_ROLES: Role[] = ["ADMIN", "EDITOR"];

export function canViewAuthorColorRoster(role: Role): boolean {
  return COLOR_ROSTER_ROLES.includes(role);
}
