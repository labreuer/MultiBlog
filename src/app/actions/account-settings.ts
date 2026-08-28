"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAuthorIdentity } from "@/lib/authz";

// users.ts's shape, restated: a "use server" module may export only async
// functions, so its copy can't be shared.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export type AccountSettingsInput = {
  name: string;
  /** undefined = leave untouched. Only offered to AUTHOR+ UIs; re-checked here. */
  adminInitials?: string;
  /** undefined = leave untouched. Only offered to AUTHOR+ UIs; re-checked here. */
  color?: string;
};

// The dashboard Settings card's one combined write — always the signed-in
// user, and the field tiers re-checked here rather than trusted from the
// form. docs/DASHBOARD.md "Settings".
export async function updateAccountSettings(input: AccountSettingsInput): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("You must be signed in.");
  }

  const data: { name: string | null; adminInitials?: string; color?: string } = {
    // Same trim-to-null as the admin-side updateUserName: a cleared name
    // falls back to email everywhere names render.
    name: input.name.trim() || null,
  };

  if (input.adminInitials !== undefined || input.color !== undefined) {
    if (!canEditAuthorIdentity(session.user.role)) {
      throw new Error("You don't have permission to change initials or author color.");
    }
  }
  if (input.adminInitials !== undefined) {
    const trimmed = input.adminInitials.trim();
    if (!trimmed) {
      throw new Error("Initials can't be empty.");
    }
    data.adminInitials = trimmed;
  }
  if (input.color !== undefined) {
    if (!HEX_COLOR_RE.test(input.color)) {
      throw new Error("Invalid color.");
    }
    data.color = input.color;
  }

  await prisma.user.update({ where: { id: session.user.id }, data });
  revalidatePath("/dashboard");
}
