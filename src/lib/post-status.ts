import type { Prisma } from "@/generated/prisma/client";

// There is no stored status field — see PLAN.md §4/§10. publishRevisionId is
// set immediately by both an immediate publish and a scheduled one; whether
// it's actually live depends purely on comparing publishedAt to now().
export type PostStatus = "draft" | "scheduled" | "published";

export function derivePostStatus(post: {
  publishRevisionId: string | null;
  publishedAt: Date | null;
}): PostStatus {
  if (!post.publishRevisionId) return "draft";
  return post.publishedAt && post.publishedAt.getTime() > Date.now() ? "scheduled" : "published";
}

// The shared "is this post actually visible" gate — every public-facing
// query must use this instead of checking publishRevisionId alone, or a
// scheduled-but-not-yet-due post (which already has publishRevisionId set)
// would leak through before its publishedAt arrives.
export function publishedPostWhere(): Prisma.PostWhereInput {
  return { publishRevisionId: { not: null }, publishedAt: { lte: new Date() }, deletedByUserId: null };
}

// The soft-delete gate alone, for queries (drafts, owner-only views, admin
// tooling) that fetch posts regardless of publish status but must still
// exclude soft-deleted ones.
//
// Narrower return type than Prisma.PostWhereInput on purpose: that wide,
// all-optional interface pollutes the type of whatever it's spread into
// (e.g. `{ id, ...nonDeletedPostWhere() }` for a findUnique) because every
// field it declares, including `id`, resurfaces in the merged object type —
// even though only deletedByUserId is ever actually set at runtime.
export function nonDeletedPostWhere(): { deletedByUserId: null } {
  return { deletedByUserId: null };
}
