"use server";

import { prisma } from "@/lib/prisma";
import { generateResetToken } from "@/lib/tokens";
import { sendMail } from "@/lib/mail";
import { nonDeletedUserWhere } from "@/lib/user-status";

export type ForgotPasswordState = { message?: string; error?: string };

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const GENERIC_MESSAGE = "If an account exists for that email, a reset link has been sent.";

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = formData.get("email");
  if (typeof email !== "string" || !email) {
    return { error: "Email is required." };
  }

  const user = await prisma.user.findUnique({ where: { email, ...nonDeletedUserWhere() } });
  if (user?.passwordHash) {
    const { raw, hash } = generateResetToken();

    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      }),
    ]);

    const resetUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${raw}`;
    await sendMail({
      to: user.email,
      subject: "Reset your MultiBlog password",
      text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
    });
  }

  // Same message whether or not the account exists, so this can't be used to enumerate emails.
  return { message: GENERIC_MESSAGE };
}
