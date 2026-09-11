import { prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify, RESERVED_SLUGS, REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";

// PLAN.md §19 — file slugs, the same shape doc slugs have (src/lib/doc-slug.ts)
// with its own uniqueness namespace: a file, a doc and a post may all carry the
// same slug and resolve to three different URLs, since /pdf/*, /doc/* and the
// post catch-all can't collide. "In use" covers both a file's current slug and
// anything sitting in its history as a redirect source.
//
// **Where files diverge from docs and posts: a deleted file's slug is free.**
// Uploading a PDF, noticing it carries embedded annotations, stripping them and
// re-uploading is an ordinary sequence, and the old row squatting on `report`
// so that the replacement is `report-2` is a bad answer to it. The database
// agrees — `file_slug_live_key` is unique only WHERE `deleted_by_user_id IS
// NULL` (schema.prisma's StoredFile) — so "in use" below means *live*, on both
// halves: a deleted file's current slug and its past ones are all available.
// Two rules follow, and they are the whole cost of the arrangement:
//
//  - nothing may look a file up by slug with `findUnique`, because two deleted
//    files may share one (`resolveFileParam` below);
//  - restoring a file whose slug has since been taken must rename it rather
//    than fail (`freeFileSlugFor` below, called from restoreFile).
//
// The predicate is written out here rather than left to the caller's client:
// `prisma` filters soft-deleted files and `prismaIncludingDeleted` doesn't,
// and this answer must not depend on which one arrived. The upload route's
// transaction is the extended one and used to rely on that filter by accident
// — which is how a re-upload became a raw P2002 rather than a `-2`.
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
      where: { slug, deletedByUserId: null, ...(excludeFileId ? { id: { not: excludeFileId } } : {}) },
      select: { id: true },
    }),
    // A redirect into a deleted file leads nowhere a reader may go, so a
    // history row only holds its slug for as long as its file is live. The
    // *index* on file_slug_history.slug stays global, which is why
    // changeFileSlug below clears a dead row out of the way before inserting.
    client.fileSlugHistory.findFirst({
      where: {
        slug,
        file: { deletedByUserId: null },
        ...(excludeFileId ? { fileId: { not: excludeFileId } } : {}),
      },
      select: { id: true },
    }),
  ]);
  return live !== null || historic !== null;
}

/** `base`, or the first `base-N` that no live file and no live redirect holds. */
async function nextFreeFileSlug(
  base: string,
  client: Prisma.TransactionClient | TransactionClient,
  excludeFileId?: string,
): Promise<string> {
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-file` : base;
  let suffix = 2;
  while (await fileSlugInUse(candidate, client, excludeFileId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
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
  return nextFreeFileSlug(slugify(title, "file"), prismaIncludingDeleted, excludeFileId);
}

/**
 * `uniqueFileSlug` run *inside* a transaction, so a slug taken by a
 * concurrently-created file is visible. The upload route calls this rather than
 * the global version: two people uploading `report.pdf` at the same moment
 * would otherwise both compute `report` and the second insert would die on the
 * unique index with a raw P2002 instead of becoming `report-2`.
 */
export async function claimFileSlug(tx: TransactionClient, title: string): Promise<string> {
  return nextFreeFileSlug(slugify(title, "file"), tx);
}

/**
 * The slug `fileId` can come back under — its own, or the first free `-N` past
 * it if a file uploaded while it was deleted has taken the name.
 *
 * The forced rename deliberately writes **no** FileSlugHistory row: history is
 * a redirect source, and the one slug this file must not claim a redirect from
 * is the one another live file is currently answering on.
 */
export async function freeFileSlugFor(
  tx: Prisma.TransactionClient | TransactionClient,
  fileId: string,
  currentSlug: string,
): Promise<string> {
  if (!(await fileSlugInUse(currentSlug, tx, fileId))) {
    return currentSlug;
  }
  // Suffixed from the slug rather than re-derived from the title: a file whose
  // url was edited by hand keeps the url it had, not the one its name implies.
  return nextFreeFileSlug(currentSlug, tx, fileId);
}

/**
 * Drops a redirect *into a deleted file* that would stand in the way of
 * recording `slug` as a live file's past url.
 *
 * file_slug_history.slug is globally unique and cannot be made partial — the
 * predicate it would need lives on the file table, not this one — while
 * fileSlugInUse stopped counting a deleted file's history as in use. That gap
 * is exactly one row wide, and this is it: the row is a redirect to a file no
 * reader may open, so the live file's claim on the name wins.
 */
async function clearDeadHistoryRow(tx: Prisma.TransactionClient | TransactionClient, slug: string): Promise<void> {
  await tx.fileSlugHistory.deleteMany({ where: { slug, file: { deletedByUserId: { not: null } } } });
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
    await clearDeadHistoryRow(tx, file.slug);
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
    // Reachable only since a deleted file stopped holding its slugs: this
    // file's own history row guarantees no *other* history row has the slug,
    // but a file uploaded while this one was deleted may hold it as its
    // current one. Refused rather than suffixed — reverting is an explicit
    // request for one particular url, and quietly handing back a different
    // one is not an answer to it.
    if (await fileSlugInUse(lastHistory.slug, tx, fileId)) {
      throw new Error(`Url "${lastHistory.slug}" is in use by another file.`);
    }
    await tx.fileSlugHistory.delete({ where: { id: lastHistory.id } });
    if (Date.now() - lastHistory.createdAt.getTime() >= REVERT_DISCARD_WINDOW_MS) {
      await clearDeadHistoryRow(tx, file.slug);
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
 *
 * **`findFirst`, not `findUnique`, and in a deliberate order.** Since
 * `file_slug_live_key` is partial, a slug is unique among live files only —
 * so a plain lookup could answer with a deleted namesake while the file
 * everyone means sits right beside it. Live beats deleted, and a redirect into
 * a *live* file beats a deleted file holding the name directly, because the
 * live one is the only one a reader may open. A deleted file is still
 * reachable by its own slug when nothing live claims it, which is what keeps
 * an admin's link to a deleted row working.
 */
export async function resolveFileParam<T extends Prisma.StoredFileSelect>(
  slug: string,
  select: T,
): Promise<{ file: Prisma.StoredFileGetPayload<{ select: T }>; redirectTo: string | null } | null> {
  const live = await prismaIncludingDeleted.storedFile.findFirst({
    where: { slug, deletedByUserId: null },
    select,
  });
  if (live) return { file: live, redirectTo: null };

  // Two queries on the redirect path rather than one with a merged select. A
  // `{ ...select, slug: true }` intersection is what the single-query form
  // needs, and TypeScript cannot prove `T & { slug: true }` is the same type it
  // just constructed (TS2719) without a cast that throws away the caller's
  // payload type. This path only runs for a slug that has already missed, so
  // the extra round trip costs nothing anyone measures.
  const historic = await prismaIncludingDeleted.fileSlugHistory.findUnique({
    where: { slug },
    select: { file: { select: { id: true, slug: true, deletedByUserId: true } } },
  });
  const followHistoric = async () => {
    if (!historic) return null;
    const file = await prismaIncludingDeleted.storedFile.findUnique({ where: { id: historic.file.id }, select });
    if (!file) return null;
    return { file, redirectTo: `/pdf/${historic.file.slug}` };
  };
  if (historic?.file.deletedByUserId === null) {
    const followed = await followHistoric();
    if (followed) return followed;
  }

  // Ordered because two *deleted* files may share a slug and neither is
  // more correct than the other; the most recently deleted is the one whoever
  // followed the link was most likely looking at.
  const deleted = await prismaIncludingDeleted.storedFile.findFirst({
    where: { slug },
    orderBy: { deletedAt: "desc" },
    select,
  });
  if (deleted) return { file: deleted, redirectTo: null };

  return followHistoric();
}
