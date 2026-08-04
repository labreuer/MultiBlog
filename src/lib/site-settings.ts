import { prisma } from "@/lib/prisma";
import type { SiteSettings } from "@/generated/prisma/client";
import { columnOrderFor, type AdminTableName } from "@/lib/column-order";

export async function getSiteSettings(): Promise<SiteSettings> {
  return prisma.siteSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });
}

// The site-wide default column order for one admin table (PLAN.md §16i) — the
// layer between a column's own code-level `ColumnSpec.defaultHidden` and a
// user's own saved order (`User.columnOrder`, which still wins over this:
// "users having an override" is that existing mechanism, not a new one).
// Same shape and same parsing as `User.columnOrder` — see column-order.ts —
// because both answer the same question, "which columns, in what order",
// just at different precedence levels.
export async function getSiteDefaultColumnOrder(table: AdminTableName): Promise<string[] | null> {
  const { defaultColumnOrder } = await getSiteSettings();
  return columnOrderFor(defaultColumnOrder, table);
}
