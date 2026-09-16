import type { Prisma } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { canEditAnyPost } from "@/lib/role-checks";

// There is no stored status field — see PLAN.md §4/§10/§15. publishEventId is
// set immediately by both an immediate publish and a scheduled one; whether
// it's actually live depends purely on comparing publishedAt to now().
export type PostStatus = "draft" | "scheduled" | "published";

export function derivePostStatus(post: {
  publishEventId: string | null;
  publishedAt: Date | null;
}): PostStatus {
  if (!post.publishEventId) return "draft";
  return post.publishedAt && post.publishedAt.getTime() > Date.now() ? "scheduled" : "published";
}

// The shared "is this post actually visible" gate — every public-facing
// query must use this instead of checking publishEventId alone, or a
// scheduled-but-not-yet-due post (which already has publishEventId set)
// would leak through before its publishedAt arrives.
//
// Doesn't need its own deletedByUserId check — src/lib/prisma.ts's `prisma`
// export is a Prisma Client Extension that excludes soft-deleted Post/User
// rows from every ordinary read automatically (see its comment for the
// handful of call sites that deliberately use the unfiltered
// prismaIncludingDeleted instead).
export function publishedPostWhere(): Prisma.PostWhereInput {
  return { publishEventId: { not: null }, publishedAt: { lte: new Date() } };
}

/**
 * "Every post this viewer may see" — `publishedPostWhere()` widened by the
 * unpublished ones they may edit.
 *
 * `canUserEditPost` (src/lib/authz.ts) as a `where` clause, ORed with the
 * public predicate. Prisma can't share a boolean predicate between a per-row
 * check and a query filter — the same caveat `readableDocsFor` and
 * `tag-browse.ts`'s `listDocs` carry — so the two are kept honest by saying
 * so: ADMIN/EDITOR see every post, an AUTHOR additionally sees the ones they
 * are on the byline of, and the `role === "AUTHOR"` narrowing is there
 * because `canUserEditPost` has it (a byline survives a demotion; the
 * permission doesn't).
 *
 * **This is a read rule, not a publication rule.** Nothing public may use it:
 * the landing page, the archives, RSS, search and `/yyyy/mm/dd/slug` all stay
 * on `publishedPostWhere()`, which is what makes "published" mean one thing.
 * It exists for the surfaces that are *already* viewer-shaped — `/tag/[slug]`
 * and `canUserTagTarget` — so that a draft can carry tags without its title
 * showing up in a stranger's list (PLAN.md §20d).
 */
export function readablePostWhere(userId: string | null, role: Role | null): Prisma.PostWhereInput {
  if (!userId || !role) return publishedPostWhere();
  if (canEditAnyPost(role)) return {};
  if (role !== "AUTHOR") return publishedPostWhere();
  return { OR: [publishedPostWhere(), { authors: { some: { userId } } }] };
}
