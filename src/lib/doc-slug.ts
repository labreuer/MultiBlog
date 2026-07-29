import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { slugify, RESERVED_SLUGS, REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";

// Doc slugs are unique among docs only (PLAN.md §12c) — a separate /doc/*
// namespace with no shared catch-all against post slugs, so a doc and a post
// may share a slug and resolve to different URLs. Otherwise the same shape
// as postSlugInUse (src/lib/post-slug.ts): "in use" covers both a doc's
// current slug and anything sitting in its history as a redirect source.
async function docSlugInUse(
  slug: string,
  client: Prisma.TransactionClient = prismaIncludingDeleted,
  excludeDocId?: string,
): Promise<boolean> {
  const [live, historic] = await Promise.all([
    client.doc.findFirst({
      where: excludeDocId ? { slug, id: { not: excludeDocId } } : { slug },
      select: { id: true },
    }),
    client.docSlugHistory.findFirst({
      where: excludeDocId ? { slug, docId: { not: excludeDocId } } : { slug },
      select: { id: true },
    }),
  ]);
  return live !== null || historic !== null;
}

export async function uniqueDocSlug(title: string, excludeDocId?: string): Promise<string> {
  const base = slugify(title, "doc");
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-doc` : base;
  let suffix = 2;
  while (await docSlugInUse(candidate, prismaIncludingDeleted, excludeDocId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

// Renames a doc's slug, recording the old one in DocSlugHistory. No-ops if
// newSlugInput normalizes to the doc's current slug.
export async function changeDocSlug(docId: string, newSlugInput: string): Promise<string> {
  const newSlug = slugify(newSlugInput, "doc");
  if (RESERVED_SLUGS.has(newSlug)) {
    throw new Error(`"${newSlug}" is a reserved path and can't be used as a doc url.`);
  }

  return prismaIncludingDeleted.$transaction(async (tx) => {
    const doc = await tx.doc.findUnique({ where: { id: docId }, select: { slug: true } });
    if (!doc) {
      throw new Error("Doc not found.");
    }
    if (doc.slug === newSlug) {
      return newSlug;
    }
    if (await docSlugInUse(newSlug, tx)) {
      throw new Error(`Url "${newSlug}" is already in use.`);
    }
    await tx.docSlugHistory.create({ data: { docId, slug: doc.slug } });
    await tx.doc.update({ where: { id: docId }, data: { slug: newSlug } });
    return newSlug;
  });
}

// Swaps a doc's slug back to its most recent past one — see
// revertPostSlug (src/lib/post-slug.ts) for the full rationale, identical here.
export async function revertDocSlug(docId: string): Promise<string> {
  return prismaIncludingDeleted.$transaction(async (tx) => {
    const doc = await tx.doc.findUnique({ where: { id: docId }, select: { slug: true } });
    if (!doc) {
      throw new Error("Doc not found.");
    }
    const lastHistory = await tx.docSlugHistory.findFirst({ where: { docId }, orderBy: { createdAt: "desc" } });
    if (!lastHistory) {
      throw new Error("No past url to revert to.");
    }
    await tx.docSlugHistory.delete({ where: { id: lastHistory.id } });
    if (Date.now() - lastHistory.createdAt.getTime() >= REVERT_DISCARD_WINDOW_MS) {
      await tx.docSlugHistory.create({ data: { docId, slug: doc.slug } });
    }
    await tx.doc.update({ where: { id: docId }, data: { slug: lastHistory.slug } });
    return lastHistory.slug;
  });
}
