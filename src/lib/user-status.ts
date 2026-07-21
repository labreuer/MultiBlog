// The soft-delete gate — every query fetching User rows (directly or via a
// relation include) must exclude soft-deleted accounts, mirroring
// nonDeletedPostWhere in post-status.ts. Deliberately narrower than
// Prisma.UserWhereInput — see the comment on nonDeletedPostWhere for why.
export function nonDeletedUserWhere(): { deletedByUserId: null } {
  return { deletedByUserId: null };
}
