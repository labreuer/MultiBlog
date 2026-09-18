import { prisma } from "./prisma";
import type { CommentStatus } from "@/generated/prisma/enums";
import { targetFromColumns, type AnchorTarget } from "./anchors";
import { isCommentPublic } from "./comment-authz";
import { commentAnchorName } from "./comment-anchor-name";
import { postPath } from "./post-path";
import type { CommentQuoteCitation, CommentQuoteCitations } from "./comment-quote-citation";

// PLAN.md §23h — the citation line, resolved server-side per anchor row.
//
// **Filtered by §23e's rule at render as well as at write.** A target can
// stop being public after it was quoted — a post unpublished, a comment sent
// to spam — and the words, public when quoted, stay in the body; what stops
// is the citation *resolving*: the label degrades to "no longer available"
// and the href goes away. Recorded rather than fixed, because unpublishing
// cannot claw back what people already read.
//
// One query for every comment on a page, so the read path adds one round
// trip rather than one per quotation. Phase 2 ships this with no writer;
// every map it returns is empty until Phase 3.

type AnchorRow = {
  id: string;
  commentId: string;
  docId: string | null;
  postId: string | null;
  fileId: string | null;
  targetAnnotationId: string | null;
  targetCommentId: string | null;
  anchoredEventId: string | null;
  quotedRevisionId: string | null;
  post: { title: string; slug: string; publishedAt: Date | null; publishEventId: string | null } | null;
  targetComment: {
    id: string;
    status: CommentStatus;
    deletedAt: Date | null;
    createdAt: Date;
    commenter: { userId: string | null; displayName: string };
    thread: { post: { id: string; slug: string; publishedAt: Date | null } };
    revisions: { id: string }[];
  } | null;
};

const UNAVAILABLE: Omit<CommentQuoteCitation, "anchorId"> = {
  label: "a source that is no longer available",
  href: null,
  stale: false,
};

/** One row → its citation; `target` is the arc already parsed off the row. */
export function describeQuoteTarget(row: AnchorRow, target: AnchorTarget): CommentQuoteCitation {
  switch (target.kind) {
    case "post": {
      const post = row.post;
      const isPublic = !!post && post.publishedAt !== null && post.publishedAt <= new Date();
      if (!post || !isPublic) return { anchorId: row.id, ...UNAVAILABLE };
      return {
        anchorId: row.id,
        label: post.title,
        href: postPath(post),
        // §23d: exact against the pinned event; "best-effort in the live
        // article" is what a later publish makes it.
        stale: row.anchoredEventId !== null && row.anchoredEventId !== post.publishEventId,
      };
    }
    case "comment": {
      const comment = row.targetComment;
      if (!comment || !isCommentPublic(comment)) return { anchorId: row.id, ...UNAVAILABLE };
      return {
        anchorId: row.id,
        label: `${comment.commenter.displayName}'s comment`,
        href: `${postPath(comment.thread.post)}#${commentAnchorName(comment.commenter.displayName, comment.createdAt)}`,
        stale: row.quotedRevisionId !== null && row.quotedRevisionId !== comment.revisions[0]?.id,
      };
    }
    // §23e: none of these has a public tier, so none is ever written; the
    // arms exist because the union is exhaustive and the envelope is shared.
    case "doc":
    case "file":
    case "annotation":
      return { anchorId: row.id, ...UNAVAILABLE };
  }
}

/**
 * Every quotation in each of `commentIds`' bodies, described. Keyed by the
 * quoting comment; each value is keyed by anchor id, which is what the body's
 * `anchorId` attributes name.
 */
export async function loadCommentQuoteCitations(commentIds: string[]): Promise<Map<string, CommentQuoteCitations>> {
  const byComment = new Map<string, CommentQuoteCitations>();
  if (commentIds.length === 0) return byComment;

  const rows = await prisma.commentQuoteAnchor.findMany({
    where: { commentId: { in: commentIds } },
    select: {
      id: true,
      commentId: true,
      docId: true,
      postId: true,
      fileId: true,
      targetAnnotationId: true,
      targetCommentId: true,
      anchoredEventId: true,
      quotedRevisionId: true,
      post: { select: { title: true, slug: true, publishedAt: true, publishEventId: true } },
      targetComment: {
        select: {
          id: true,
          status: true,
          deletedAt: true,
          createdAt: true,
          commenter: { select: { userId: true, displayName: true } },
          thread: { select: { post: { select: { id: true, slug: true, publishedAt: true } } } },
          revisions: { orderBy: { revisionNo: "desc" }, take: 1, select: { id: true } },
        },
      },
    },
  });

  for (const row of rows) {
    const target = targetFromColumns(row);
    if (!target) continue;
    const citations = byComment.get(row.commentId) ?? {};
    citations[row.id] = describeQuoteTarget(row, target);
    byComment.set(row.commentId, citations);
  }
  return byComment;
}
