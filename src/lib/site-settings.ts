import { prisma } from "@/lib/prisma";
import type { SiteSettings } from "@/generated/prisma/client";

export async function getSiteSettings(): Promise<SiteSettings> {
  return prisma.siteSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}
