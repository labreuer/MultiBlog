"use server";

import { prisma } from "@/lib/prisma";
import { generateToken } from "@/lib/tokens";
import { sendMail } from "@/lib/mail";
import { appUrl } from "@/lib/app-url";
import { SITE_TITLE } from "@/lib/site-config";

export type ForgotPasswordState = { message?: string; error?: string };

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
// Below this age, a live reset token's own createdAt already means "mail went
// out recently" — no separate rate-limit table needed. Docs/EMAIL.md §3
// covers why this must still return GENERIC_MESSAGE rather than a distinct
// "try again in a minute" message: a different response for "already has a
// fresh token" vs. "sent one" would itself be an enumeration oracle.
const RESEND_COOLDOWN_MS = 60 * 1000;
const GENERIC_MESSAGE = "If an account exists for that email, a reset link has been sent.";

export async function requestPasswordReset(
  _prevState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const email = formData.get("email");
  if (typeof email !== "string" || !email) {
    return { error: "Email is required." };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (user?.passwordHash) {
    const existing = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const onCooldown = existing && Date.now() - existing.createdAt.getTime() < RESEND_COOLDOWN_MS;

    if (!onCooldown) {
      const { raw, hash } = generateToken();

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

      const resetUrl = appUrl(`/reset-password?token=${raw}`);
      await sendMail({
        to: user.email,
        subject: `Reset your ${SITE_TITLE} password`,
        text: `Reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
      });
    }
  }

  // Same message whether or not the account exists (or is on cooldown), so
  // this can't be used to enumerate emails.
  return { message: GENERIC_MESSAGE };
}
