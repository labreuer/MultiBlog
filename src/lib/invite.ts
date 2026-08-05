import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";

// An invite sits in an inbox, unlike a password reset link someone is
// actively waiting on — 1h would mean constant re-sending. Full design:
// docs/EMAIL.md.
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type LiveInvite = {
  id: string;
  userId: string;
  clickedAt: Date | null;
  user: { email: string; deletedAt: Date | null; emailVerified: Date | null };
};

// Per-token, never per-user: there is no delete-priors step on send (§3 of
// docs/EMAIL.md — several invites may be live for one user at once), so
// clicking invite #1 must not invalidate #2. Only acceptance revokes siblings
// (acceptInvite in src/app/actions/invite.ts).
export async function findLiveInvite(rawToken: string): Promise<LiveInvite | null> {
  const invite = await prisma.userInvite.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: {
      id: true,
      userId: true,
      clickedAt: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      // The soft-delete extension (src/lib/prisma.ts) only filters
      // operations on post/user/doc directly — a nested relation read like
      // this one is NOT filtered, so a soft-deleted recipient must be
      // checked by hand below.
      user: { select: { email: true, deletedAt: true, emailVerified: true } },
    },
  });

  if (!invite) return null;
  if (invite.revokedAt || invite.acceptedAt) return null;
  if (invite.expiresAt < new Date()) return null;
  if (invite.user.deletedAt) return null;

  return { id: invite.id, userId: invite.userId, clickedAt: invite.clickedAt, user: invite.user };
}
