import type { CommentStatus, Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { canUserEditPost } from "./authz";
import { publishedPostWhere } from "./post-status";

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
  thread: { post: { id: string; publishedAt: Date | null } };
};

/** The public case alone: what a signed-out reader sees. Synchronous, no session. */
export function isCommentPublic(comment: ReadableComment): boolean {
  return comment.status === "APPROVED" && comment.deletedAt === null && comment.thread.post.publishedAt !== null;
}

/**
 * The public case as a `where` on Comment: what search, the quote picker and
 * the quote matcher's candidate list go through. `publishedPostWhere()` is
 * reached through a relation here, which prisma.ts's soft-delete $extends
 * does not follow.
 *
 * isCommentPublic above tests less than this: `publishedAt !== null` admits
 * a post that was unpublished (which leaves `publishedAt` set) or is only
 * scheduled. docs/FULLTEXT.md §9, step 1.
 */
export function publicCommentsWhere(): Prisma.CommentWhereInput {
  return { status: "APPROVED", deletedAt: null, thread: { post: publishedPostWhere() } };
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
