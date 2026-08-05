"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { findLiveInvite } from "@/lib/invite";

export type AcceptInviteState = { error?: string; success?: boolean };

const INVALID_MESSAGE = "This invite link is invalid, expired, or has already been used.";

// Public — belongs beside reset-password.ts, not in actions/users.ts, since
// this is the invitee acting on their own account, not an admin acting on
// someone else's. Re-validates from scratch rather than trusting anything
// the page already checked, same as resetPassword does.
export async function acceptInvite(
  _prevState: AcceptInviteState,
  formData: FormData,
): Promise<AcceptInviteState> {
  const token = formData.get("token");
  const password = formData.get("password");

  if (typeof token !== "string" || !token) {
    return { error: INVALID_MESSAGE };
  }
  if (typeof password !== "string" || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const invite = await findLiveInvite(token);
  if (!invite) {
    return { error: INVALID_MESSAGE };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();

  await prisma.$transaction([
    // Clicking a link in the inbox is exactly what emailVerified claims to
    // mean, so accepting an invite makes the /users column truthful — but it
    // still gates nothing (docs/EMAIL.md).
    prisma.user.update({
      where: { id: invite.userId },
      data: { passwordHash, emailVerified: invite.user.emailVerified ?? now },
    }),
    prisma.userInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: now, clickedAt: invite.clickedAt ?? now, token: null },
    }),
    // Several invites can be live for one user at once (docs/EMAIL.md §3);
    // accepting one is what retires the rest, not the send step.
    prisma.userInvite.updateMany({
      where: { userId: invite.userId, id: { not: invite.id }, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now, token: null },
    }),
    // A deliberately-set password should retire any outstanding reset link
    // for the same account, same as resetPassword does for itself.
    prisma.passwordResetToken.deleteMany({ where: { userId: invite.userId } }),
  ]);

  return { success: true };
}
