import { Prisma } from "@/generated/prisma/client";
import { prismaIncludingDeleted as prisma } from "@/lib/prisma";
import { cslOf, type CslItem } from "@/lib/references/csl";
import { normalizeDoi, normalizeIsbn } from "@/lib/references/identifiers";
import { isKeyShaped, lookupKey } from "@/lib/references/keys";

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
 * The reference a key names, or once named, ignoring case: `key` on the row
 * is its key now, which differs when the key asked is one it used to have or
 * is written in another case. Deleted ones included, flagged.
 */
export async function referenceByKey(key: string): Promise<ReferenceRow | null> {
  if (!isKeyShaped(key)) return null;
  const folded = lookupKey(key);
  const direct = await prisma.reference.findUnique({ where: { keyFolded: folded }, select: ROW_SELECT });
  if (direct) return toRow(direct);
  const historic = await prisma.referenceKeyHistory.findUnique({ where: { keyFolded: folded }, select: { reference: { select: ROW_SELECT } } });
  return historic ? toRow(historic.reference) : null;
}

/**
 * The references these keys name, or once named, ignoring case, by the key
 * as it was asked, since each caller looks up its own spelling: each one's id
 * and whether it is deleted. A key nothing answers to is absent. For the
 * Markdown parse, which names works by key (parsed-chips.ts), and `cites`.
 */
export async function referencesByKeys(keys: readonly string[]): Promise<Map<string, { id: string; deleted: boolean }>> {
  const found = new Map<string, { id: string; deleted: boolean }>();
  const asked = keys.filter(isKeyShaped);
  if (asked.length === 0) return found;
  const folded = [...new Set(asked.map(lookupKey))];
  const byFolded = new Map<string, { id: string; deleted: boolean }>();
  const direct = await prisma.reference.findMany({ where: { keyFolded: { in: folded } }, select: { id: true, keyFolded: true, deletedAt: true } });
  for (const row of direct) byFolded.set(row.keyFolded, { id: row.id, deleted: row.deletedAt !== null });
  const rest = folded.filter((key) => !byFolded.has(key));
  if (rest.length > 0) {
    const historic = await prisma.referenceKeyHistory.findMany({
      where: { keyFolded: { in: rest } },
      select: { keyFolded: true, reference: { select: { id: true, deletedAt: true } } },
    });
    for (const row of historic) byFolded.set(row.keyFolded, { id: row.reference.id, deleted: row.reference.deletedAt !== null });
  }
  for (const key of asked) {
    const reference = byFolded.get(lookupKey(key));
    if (reference) found.set(key, reference);
  }
  return found;
}

/** The references with these ids, by id, deleted ones included: a citation's context. */
export async function referencesById(ids: readonly string[]): Promise<Map<string, ReferenceRow>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.reference.findMany({ where: { id: { in: [...ids] } }, select: ROW_SELECT });
  return new Map(rows.flatMap((row) => (toRow(row) ? [[row.id, toRow(row)!] as const] : [])));
}


/**
 * The ids of the references a cited-work filter names (docs/CITATIONS.md,
 * "Search"): each word as a prefix, ANDed, over the title (the vector's
 * weight A, which holds the key and abbreviation too) or over the people
 * (weight B, authors and editors). Deleted references included, since a
 * citation of one still names the work.
 */
export async function referenceIdsMatching(text: string, field: "title" | "author"): Promise<string[]> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const weight = field === "title" ? "A" : "B";
  // Built from the words alone, so nothing typed is tsquery syntax.
  const tsquery = words.map((word) => `${word}:*${weight}`).join(" & ");
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT r.id
    FROM "reference" r, to_tsquery('public.english_unaccent', ${tsquery}) AS query
    WHERE r.search_vector @@ query`);
  return rows.map((row) => row.id);
}

/**
 * Live references matching `query`, best first: one by its DOI or ISBN when
 * the query is one, otherwise by the words of its key, abbreviation, title,
 * people, container and year. A word still being typed matches as a prefix,
 * so "radn" finds Radner. `within`, when given, keeps to those ids: a post's
 * own works, which a comment's menu lists first.
 */
export async function findReferences(query: string, limit: number, within?: readonly string[]): Promise<ReferenceRow[]> {
  const q = query.trim();
  if (!q || within?.length === 0) return [];
  const doi = normalizeDoi(q);
  const isbn = normalizeIsbn(q);
  if (doi || isbn) {
    const held = await prisma.referenceIdentifier.findFirst({
      where: doi ? { scheme: "DOI", value: doi } : { scheme: "ISBN", value: isbn! },
      select: { reference: { select: ROW_SELECT } },
    });
    const row = held && !held.reference.deletedAt && (!within || within.includes(held.reference.id)) ? toRow(held.reference) : null;
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
      ${within ? Prisma.sql`AND r.id = ANY(${[...within]}::text[])` : Prisma.empty}
    ORDER BY ts_rank_cd(r.search_vector, query) DESC, r.key ASC
    LIMIT ${limit}`);
  const byId = await referencesById(ranked.map((row) => row.id));
  return ranked.flatMap((row) => (byId.get(row.id) ? [byId.get(row.id)!] : []));
}
