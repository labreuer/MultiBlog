"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/authz";

async function requireAdmin(): Promise<void> {
  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) {
    throw new Error("You don't have permission to manage site settings.");
  }
}

// Site-level default excludes INHERIT — there's no level above it left to
// defer to (see moderation.ts's resolveCascadePolicy, which types the site
// policy as "ALWAYS" | "AUTO" for exactly this reason).
export async function updateSiteDefaultModerationPolicy(policy: "ALWAYS" | "AUTO"): Promise<void> {
  await requireAdmin();
  if (policy !== "ALWAYS" && policy !== "AUTO") {
    throw new Error("Invalid moderation policy.");
  }
  await prisma.siteSettings.upsert({
    where: { id: 1 },
    update: { defaultModerationPolicy: policy },
    create: { id: 1, defaultModerationPolicy: policy },
  });
  revalidatePath("/site-settings");
}

export async function updateSiteTrustThreshold(trustThreshold: number): Promise<void> {
  await requireAdmin();
  if (!Number.isInteger(trustThreshold) || trustThreshold < 0) {
    throw new Error("Trust threshold must be a non-negative whole number.");
  }
  await prisma.siteSettings.upsert({
    where: { id: 1 },
    update: { trustThreshold },
    create: { id: 1, trustThreshold },
  });
  revalidatePath("/site-settings");
}
