import { prisma } from "@/lib/prisma";
import { coercePageSize, FALLBACK_PAGE_SIZE, type PageSize } from "@/lib/table-query";

// A user's default rows-per-page for every admin table (PLAN.md §16b).
//
// Read from the database per request rather than baked into the session JWT:
// the JWT fixes id/role/color at sign-in and never re-reads them (see
// src/app/sign-in/NOTES.md), so a preference the user just changed wouldn't
// apply until their next session. One narrow query per admin page load.
//
// A missing user (a row deleted mid-session — the JWT outlives it) falls back
// rather than throwing: an admin table failing to render because of a *page
// size* would be an absurd way to surface that.
export async function getDefaultPageSize(userId: string): Promise<PageSize> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { rowsPerPage: true } });
  return user ? coercePageSize(user.rowsPerPage) : FALLBACK_PAGE_SIZE;
}
