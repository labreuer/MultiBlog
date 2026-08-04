"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { isAdmin } from "@/lib/authz";
import { getSiteSettings } from "@/lib/site-settings";
import type { AdminTableName } from "@/lib/column-order";

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

// The site-wide default column order for one admin table (PLAN.md §16i) —
// read-modify-write, same shape and same reason as saveTableColumns
// (src/app/actions/table-preferences.ts): the column holds one small object
// for every table, and Prisma has no typed partial update for a Json field.
export async function updateSiteDefaultColumnOrder(table: AdminTableName, cols: string[]): Promise<void> {
  await requireAdmin();

  const settings = await getSiteSettings();
  const existing =
    settings.defaultColumnOrder !== null &&
    typeof settings.defaultColumnOrder === "object" &&
    !Array.isArray(settings.defaultColumnOrder)
      ? (settings.defaultColumnOrder as Prisma.InputJsonObject)
      : {};

  await prisma.siteSettings.upsert({
    where: { id: 1 },
    update: { defaultColumnOrder: { ...existing, [table]: cols } satisfies Prisma.InputJsonObject },
    create: { id: 1, defaultColumnOrder: { [table]: cols } satisfies Prisma.InputJsonObject },
  });

  // Every admin table reads this default on render, not just this settings
  // page — the whole point is that it changes what an admin who has never
  // saved their own preference for that table sees.
  revalidatePath("/site-settings");
  revalidatePath(`/${table}`);
}
