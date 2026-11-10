import { Prisma } from "@/generated/prisma/client";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { ReferencesFilters } from "@/lib/references-query";

// docs/CITATIONS.md, "Downloads" — the rows /references' search selects, as
// one `where`, shared by the page and the download of what it matches, so
// when the table's search grows its download follows with no change of its
// own. Server-only.

/** The ids whose search vector matches every word typed, each as a prefix: what the search box narrows to. */
async function matchingIds(q: string): Promise<string[] | null> {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const tsquery = words.map((word) => `${word}:*`).join(" & ");
  const rows = await prismaIncludingDeleted.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT r.id FROM "reference" r WHERE r.search_vector @@ to_tsquery('public.english_unaccent', ${tsquery})`);
  return rows.map((row) => row.id);
}

/** What the table lists for these filters: the box's words, each a prefix, and the deleted toggle. */
export async function referencesWhere(filters: Pick<ReferencesFilters, "q" | "deleted">): Promise<Prisma.ReferenceWhereInput> {
  const where: Prisma.ReferenceWhereInput = {};
  if (!filters.deleted) where.deletedAt = null;
  if (filters.q) {
    const ids = await matchingIds(filters.q);
    if (ids) where.id = { in: ids };
  }
  return where;
}
