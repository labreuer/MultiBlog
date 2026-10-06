import type { CommentStatus, Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { canUserEditPost } from "./authz";
import { isPostPublic, publishedPostWhere } from "./post-status";

// PLAN.md §23e — who may read a comment, as one predicate the comment actions
// and the quote gate share rather than restate.
//
// An APPROVED, undeleted comment on a published post is public: that is what
// the post page shows to a signed-out reader. Anything else — pending, spam,
// deleted, or on a post that is no longer live — is its own author's and the
// post's moderators' (`canUserEditPost`, the moderation gate).

export type ReadableComment = {
  status: CommentStatus;
  deletedAt: Date | null;
  commenter: { userId: string | null };
  thread: {
    post: { id: string; publishedAt: Date | null; publishEventId: string | null; deletedByUserId: string | null };
  };
};

/**
 * The public case alone: what a signed-out reader sees. Synchronous, no session.
 *
 * "Published" is `isPostPublic`: a live publication *and* a go-live date that
 * has arrived. `publishedAt` alone is not enough — unpublishing leaves it set,
 * and scheduling sets it to a future date — and neither post has a page that
 * shows its comments. The post is reached through a relation, which prisma.ts's
 * soft-delete $extends does not follow, so `isPostPublic` checks its deletion
 * too.
 */
export function isCommentPublic(comment: ReadableComment): boolean {
  return comment.status === "APPROVED" && comment.deletedAt === null && isPostPublic(comment.thread.post);
}

/**
 * isCommentPublic as a `where` on Comment — the same test, so a list and a
 * per-row check can't disagree about one comment. What search, the quote
 * picker and the quote matcher's candidate list go through.
 */
export function publicCommentsWhere(): Prisma.CommentWhereInput {
  return {
    status: "APPROVED",
    deletedAt: null,
    thread: { post: { ...publishedPostWhere(), deletedByUserId: null } },
  };
}

export async function canUserReadComment(
  viewer: { id: string; role: Role } | null,
  comment: ReadableComment,
): Promise<boolean> {
  if (isCommentPublic(comment)) return true;
  if (!viewer) return false;
  if (comment.commenter.userId === viewer.id) return true;
  return canUserEditPost(viewer.id, viewer.role, comment.thread.post.id);
}
