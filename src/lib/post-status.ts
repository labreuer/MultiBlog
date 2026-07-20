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
  return { publishRevisionId: { not: null }, publishedAt: { lte: new Date() } };
}
