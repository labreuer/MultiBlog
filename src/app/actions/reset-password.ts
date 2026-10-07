"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/tokens";

export type ResetPasswordState = { error?: string; success?: boolean };

export async function resetPassword(
  _prevState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const token = formData.get("token");
  const password = formData.get("password");

  if (typeof token !== "string" || !token) {
    return { error: "This reset link is invalid or has expired." };
  }
  if (typeof password !== "string" || password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!record || record.expiresAt < new Date()) {
    return { error: "This reset link is invalid or has expired." };
  }
  // A link mailed before its account was soft-deleted is still unexpired, and
  // the update below is a write, which src/lib/prisma.ts's soft-delete filter
  // doesn't touch — so without this read (which it does filter) a deleted
  // user could set the password their account is later restored with.
  const user = await prisma.user.findUnique({ where: { id: record.userId }, select: { id: true } });
  if (!user) {
    return { error: "This reset link is invalid or has expired." };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: record.userId } }),
  ]);

  return { success: true };
}
