import { Prisma } from "@/generated/prisma/client";
import { prismaIncludingDeleted as prisma } from "@/lib/prisma";
import { cslOf, type CslItem } from "@/lib/references/csl";
import { normalizeDoi, normalizeIsbn } from "@/lib/references/identifiers";

// docs/CITATIONS.md — reading the reference library. A reference's record is
// public (its page is what a published post's citations link to), so nothing
// here takes a viewer; what only some may see, such as its PDF, is asked for
// by whoever shows it, under that thing's own rule.
//
// On the base client, filtering `deletedAt` by hand: `reference` is not in
// the soft-delete extension (schema.prisma says why).

export type ReferenceRow = {
  id: string;
  key: string;
  short: string | null;
  item: CslItem;
  fileId: string | null;
  deleted: boolean;
};

const ROW_SELECT = { id: true, key: true, short: true, csl: true, fileId: true, deletedAt: true } as const;

function toRow(row: { id: string; key: string; short: string | null; csl: unknown; fileId: string | null; deletedAt: Date | null }): ReferenceRow | null {
  const item = cslOf(row.csl);
  return item ? { id: row.id, key: row.key, short: row.short, item, fileId: row.fileId, deleted: row.deletedAt !== null } : null;
}

/**
 * The reference a key names, or once named: `current` is its key now, which
 * differs when `key` is one it used to have. Deleted ones included, flagged.
 */
export async function referenceByKey(key: string): Promise<ReferenceRow | null> {
  const direct = await prisma.reference.findUnique({ where: { key }, select: ROW_SELECT });
  if (direct) return toRow(direct);
  const historic = await prisma.referenceKeyHistory.findUnique({ where: { key }, select: { reference: { select: ROW_SELECT } } });
  return historic ? toRow(historic.reference) : null;
}

/** The references with these ids, by id, deleted ones included: a citation's context. */
export async function referencesById(ids: readonly string[]): Promise<Map<string, ReferenceRow>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.reference.findMany({ where: { id: { in: [...ids] } }, select: ROW_SELECT });
  return new Map(rows.flatMap((row) => (toRow(row) ? [[row.id, toRow(row)!] as const] : [])));
}

/**
 * Live references matching `query`, best first: one by its DOI or ISBN when
 * the query is one, otherwise by the words of its key, abbreviation, title,
 * people, container and year. A word still being typed matches as a prefix,
 * so "radn" finds Radner.
 */
export async function findReferences(query: string, limit: number): Promise<ReferenceRow[]> {
  const q = query.trim();
  if (!q) return [];
  const doi = normalizeDoi(q);
  const isbn = normalizeIsbn(q);
  if (doi || isbn) {
    const held = await prisma.referenceIdentifier.findFirst({
      where: doi ? { scheme: "DOI", value: doi } : { scheme: "ISBN", value: isbn! },
      select: { reference: { select: ROW_SELECT } },
    });
    const row = held && !held.reference.deletedAt ? toRow(held.reference) : null;
    return row ? [row] : [];
  }
  // Each word as a prefix, ANDed: built from the words alone, so nothing typed is tsquery syntax.
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const tsquery = words.map((word) => `${word}:*`).join(" & ");
  const ranked = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT r.id
    FROM "reference" r, to_tsquery('public.english_unaccent', ${tsquery}) AS query
    WHERE r.deleted_at IS NULL AND r.search_vector @@ query
    ORDER BY ts_rank_cd(r.search_vector, query) DESC, r.key ASC
    LIMIT ${limit}`);
  const byId = await referencesById(ranked.map((row) => row.id));
  return ranked.flatMap((row) => (byId.get(row.id) ? [byId.get(row.id)!] : []));
}
