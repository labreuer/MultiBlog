import { prisma } from "@/lib/prisma";
import { coercePageSize, DEFAULT_TABLE_PREFS, type TablePrefs } from "@/lib/table-query";
import { columnOrderFor, type AdminTableName } from "@/lib/column-order";
import { getSiteDefaultColumnOrder } from "@/lib/site-settings";

export type { AdminTableName };

// A user's stored preferences for one admin table (PLAN.md §16b, §16i) — page
// size, and that table's column visibility/order.
//
// Read from the database per request rather than baked into the session JWT:
// the JWT fixes id/role/color at sign-in and never re-reads them (see
// src/app/sign-in/NOTES.md), so a preference the user just changed wouldn't
// apply until their next session. Two small queries rather than one — the
// user row and `SiteSettings` are different tables — run concurrently rather
// than one after the other, since the second is only needed as a fallback and
// there's no reason to wait for the first to find that out.
//
// The `cols` precedence is: this user's own saved order, else the site's
// configured default for this table, else `null` — meaning neither has an
// opinion, so `resolveColumns` falls back to each column's own
// `ColumnSpec.defaultHidden` in code. A missing user (a row deleted
// mid-session — the JWT outlives it) still gets the site default rather than
// jumping straight to the code fallback; only `pageSize` needs the user row
// to exist.
export async function getTablePrefs(userId: string, table: AdminTableName): Promise<TablePrefs> {
  const [user, siteDefaultCols] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { rowsPerPage: true, columnOrder: true } }),
    getSiteDefaultColumnOrder(table),
  ]);
  if (!user) return { ...DEFAULT_TABLE_PREFS, cols: siteDefaultCols };

  return {
    pageSize: coercePageSize(user.rowsPerPage),
    cols: columnOrderFor(user.columnOrder, table) ?? siteDefaultCols,
  };
}
