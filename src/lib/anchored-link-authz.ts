import type { Role } from "@/generated/prisma/enums";

// docs/ANCHORED_LINKS.md, docs/PERMISSIONS.md — who may delete (and restore)
// a minted anchored link. Pure role/ownership checks with no Prisma import,
// so the page can decide per row from columns it already selected.
//
// Both are here rather than in role-checks.ts by that file's own rule: what
// earns a place there is a *client* consumer, and nothing in the browser asks
// these questions — /links computes `canManage` server-side and hands the
// table a boolean, the way /files does.

// Deleting someone else's link is a moderation act, and stops at the two
// roles every other "act on other people's work" rule stops at
// (canEditAnyPost, canEditAnySharedDoc, canCurateTags). Stated independently
// of all three rather than delegating to one, for the reason those give:
// a delegation would preserve exactly the coupling the separation exists to
// break, and if links should ever differ this is the function to change.
export const LINK_MODERATOR_ROLES: Role[] = ["ADMIN", "EDITOR"];

export function canModerateAnchoredLinks(role: Role): boolean {
  return LINK_MODERATOR_ROLES.includes(role);
}

/**
 * Whether `userId` may soft-delete or restore this link: its creator, or a
 * moderator, and only once it is minted. **A draft is never deleted from
 * here** — it is its creator's working set, hard-deleted by the tray's
 * Discard, and soft-deleting one would leave a restorable row that could
 * later collide with the one-open-draft-per-user partial index. The creator
 * has no role floor, matching `addAnchoredLinkPart`: pointing claims
 * nothing, and un-pointing claims less.
 */
export function canUserDeleteAnchoredLink(
  userId: string,
  role: Role,
  link: { createdById: string; mintedAt: Date | null },
): boolean {
  if (link.mintedAt === null) return false;
  return link.createdById === userId || canModerateAnchoredLinks(role);
}
