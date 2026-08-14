import { prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify, RESERVED_SLUGS, REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";

// PLAN.md §19 — file slugs, the same shape doc slugs have (src/lib/doc-slug.ts)
// with its own uniqueness namespace: a file, a doc and a post may all carry the
// same slug and resolve to three different URLs, since /pdf/*, /doc/* and the
// post catch-all can't collide. "In use" covers both a file's current slug and
// anything sitting in its history as a redirect source.
//
// `files` and `pdf` were added to RESERVED_SLUGS (src/lib/slug.ts) when this
// landed: those are new top-level route segments, so a *post* slug matching
// either would be shadowed by the static route. That reservation is about
// posts, not about files — a file slug can't collide with its own route
// segment because it lives one level down.
async function fileSlugInUse(
  slug: string,
  client: Prisma.TransactionClient | TransactionClient = prismaIncludingDeleted,
  excludeFileId?: string,
): Promise<boolean> {
  const [live, historic] = await Promise.all([
    client.storedFile.findFirst({
      where: excludeFileId ? { slug, id: { not: excludeFileId } } : { slug },
      select: { id: true },
    }),
    client.fileSlugHistory.findFirst({
      where: excludeFileId ? { slug, fileId: { not: excludeFileId } } : { slug },
      select: { id: true },
    }),
  ]);
  return live !== null || historic !== null;
}

/**
 * A free slug for `title`, checked against the global client.
 *
 * **Not safe on its own inside a transaction that is also creating files** —
 * the same caveat `uniqueDocSlug` carries, and the reason the importers use a
 * claim-through-the-transaction helper. The upload route creates one file per
 * request, so the window is a genuine concurrent double-upload of the same
 * filename; `claimFileSlug` below is what closes it.
 */
export async function uniqueFileSlug(title: string, excludeFileId?: string): Promise<string> {
  const base = slugify(title, "file");
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-file` : base;
  let suffix = 2;
  while (await fileSlugInUse(candidate, prismaIncludingDeleted, excludeFileId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * `uniqueFileSlug` run *inside* a transaction, so a slug taken by a
 * concurrently-created file is visible. The upload route calls this rather than
 * the global version: two people uploading `report.pdf` at the same moment
 * would otherwise both compute `report` and the second insert would die on the
 * unique index with a raw P2002 instead of becoming `report-2`.
 */
export async function claimFileSlug(tx: TransactionClient, title: string): Promise<string> {
  const base = slugify(title, "file");
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-file` : base;
  let suffix = 2;
  while (await fileSlugInUse(candidate, tx)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Renames a file's slug, recording the old one in FileSlugHistory. No-ops if unchanged. */
export async function changeFileSlug(fileId: string, newSlugInput: string, updatedByUserId: string): Promise<string> {
  const newSlug = slugify(newSlugInput, "file");
  if (RESERVED_SLUGS.has(newSlug)) {
    throw new Error(`"${newSlug}" is a reserved path and can't be used as a file url.`);
  }

  return prismaIncludingDeleted.$transaction(async (tx) => {
    const file = await tx.storedFile.findUnique({ where: { id: fileId }, select: { slug: true } });
    if (!file) {
      throw new Error("File not found.");
    }
    if (file.slug === newSlug) {
      return newSlug;
    }
    if (await fileSlugInUse(newSlug, tx)) {
      throw new Error(`Url "${newSlug}" is already in use.`);
    }
    await tx.fileSlugHistory.create({ data: { fileId, slug: file.slug } });
    await tx.storedFile.update({ where: { id: fileId }, data: { slug: newSlug, updatedByUserId } });
    return newSlug;
  });
}

/** Swaps a file's slug back to its most recent past one — see revertDocSlug for the full rationale. */
export async function revertFileSlug(fileId: string, updatedByUserId: string): Promise<string> {
  return prismaIncludingDeleted.$transaction(async (tx) => {
    const file = await tx.storedFile.findUnique({ where: { id: fileId }, select: { slug: true } });
    if (!file) {
      throw new Error("File not found.");
    }
    const lastHistory = await tx.fileSlugHistory.findFirst({ where: { fileId }, orderBy: { createdAt: "desc" } });
    if (!lastHistory) {
      throw new Error("No past url to revert to.");
    }
    await tx.fileSlugHistory.delete({ where: { id: lastHistory.id } });
    if (Date.now() - lastHistory.createdAt.getTime() >= REVERT_DISCARD_WINDOW_MS) {
      await tx.fileSlugHistory.create({ data: { fileId, slug: file.slug } });
    }
    await tx.storedFile.update({ where: { id: fileId }, data: { slug: lastHistory.slug, updatedByUserId } });
    return lastHistory.slug;
  });
}

/**
 * Resolves a `/pdf/[slug]` param to a file, following FileSlugHistory when the
 * slug is a past one. The `redirectTo` field is how the route knows to answer
 * with a redirect rather than rendering at a stale URL — same contract
 * resolveDocParam has.
 *
 * Uses prismaIncludingDeleted so a soft-deleted file still *resolves*; the
 * caller decides what to do about it (the reading route 404s, a future manage
 * route would want to offer an undelete).
 */
export async function resolveFileParam<T extends Prisma.StoredFileSelect>(
  slug: string,
  select: T,
): Promise<{ file: Prisma.StoredFileGetPayload<{ select: T }>; redirectTo: string | null } | null> {
  const direct = await prismaIncludingDeleted.storedFile.findUnique({ where: { slug }, select });
  if (direct) return { file: direct, redirectTo: null };

  // Two queries on the redirect path rather than one with a merged select. A
  // `{ ...select, slug: true }` intersection is what the single-query form
  // needs, and TypeScript cannot prove `T & { slug: true }` is the same type it
  // just constructed (TS2719) without a cast that throws away the caller's
  // payload type. This path only runs for a slug that has already missed, so
  // the extra round trip costs nothing anyone measures.
  const historic = await prismaIncludingDeleted.fileSlugHistory.findUnique({
    where: { slug },
    select: { file: { select: { id: true, slug: true } } },
  });
  if (!historic) return null;

  const file = await prismaIncludingDeleted.storedFile.findUnique({ where: { id: historic.file.id }, select });
  if (!file) return null;
  return { file, redirectTo: `/pdf/${historic.file.slug}` };
}
