"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import CommentForm from "./CommentForm";
import { deleteComment } from "@/app/actions/comments";
import styles from "./CommentNode.module.css";

export type CommentNodeData = {
  id: string;
  displayName: string;
  bodyText: string;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
  replies: CommentNodeData[];
};

type Props = {
  comment: CommentNodeData;
  postId: string;
  depth?: number;
};

// A permalink id for the comment — down to the second is enough that a
// collision would mean the same person posted twice in the same second,
// which shouldn't happen; not worth guarding.
function anchorName(displayName: string, createdAt: string): string {
  const name = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const timestamp = new Date(createdAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${name || "comment"}-${timestamp}`;
}

// Whether any comment anywhere below this one (not just direct replies) is
// still live — a deleted comment with no live descendants collapses
// entirely rather than leaving a "[deleted]" placeholder with nothing under it.
export function hasNonDeletedDescendant(comment: CommentNodeData): boolean {
  return comment.replies.some((reply) => reply.deletedByUserId === null || hasNonDeletedDescendant(reply));
}

export default function CommentNode({ comment, postId, depth = 0 }: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  const viewerId = session?.user?.id ?? null;
  const isAdmin = session?.user?.role === "ADMIN";
  const [replying, setReplying] = useState(false);
  const [posted, setPosted] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, startDeleteTransition] = useTransition();
  // Set only by this viewer's own click on "Yes" below — overrides the
  // collapse-to-nothing behavior so deleting your own comment gets visible
  // "[deleted]" feedback instead of it just silently vanishing. A fresh page
  // load never sets this, so the collapse rule still applies there.
  const [justDeleted, setJustDeleted] = useState(false);
  const anchorId = anchorName(comment.displayName, comment.createdAt);
  const isDeleted = comment.deletedByUserId !== null || justDeleted;

  if (isDeleted && !justDeleted && !hasNonDeletedDescendant(comment)) {
    return null;
  }

  const isOwnComment = viewerId !== null && comment.commenterUserId === viewerId;
  const canDelete = isAdmin || isOwnComment;
  // Admin power being used on someone else's comment gets a visibly
  // different (maroon) button; deleting your own comment, even as an
  // admin, is just the normal action.
  const isAdminOnOthers = isAdmin && !isOwnComment;

  const handleDelete = () => {
    setDeleteError(null);
    startDeleteTransition(async () => {
      try {
        await deleteComment(comment.id);
        setJustDeleted(true);
        router.refresh();
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : "Failed to delete comment.");
      }
    });
  };

  return (
    <div className={`${styles.node} ${depth > 0 ? styles.nested : ""}`}>
      {isDeleted ? (
        <div className={styles.deleted} data-comment-id={comment.id}>
          [deleted]
        </div>
      ) : (
        <div data-comment-id={comment.id}>
          <p className={styles.meta}>
            <span className={styles.name}>{comment.displayName}</span>
            <a id={anchorId} href={`#${anchorId}`} className={styles.timestamp}>
              {new Date(comment.createdAt).toLocaleString()}
            </a>
          </p>
          <p>{comment.bodyText}</p>
          {!posted && (
            <button type="button" onClick={() => setReplying((r) => !r)} className={styles.replyButton}>
              {replying ? "Cancel" : "Reply"}
            </button>
          )}
          {canDelete && !confirmingDelete && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className={isAdminOnOthers ? styles.deleteButtonAdmin : styles.deleteButton}
            >
              Delete
            </button>
          )}
          {confirmingDelete && (
            <span className={styles.confirmPrompt}>
              Are you sure you want to delete?{" "}
              <button type="button" onClick={handleDelete} disabled={deletePending} className={styles.confirmYes}>
                Yes
              </button>{" "}
              /{" "}
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deletePending}
                className={styles.confirmNo}
              >
                No
              </button>
            </span>
          )}
          {deleteError && <p className={styles.error}>{deleteError}</p>}
        </div>
      )}
      {replying && !posted && (
        <CommentForm postId={postId} parentCommentId={comment.id} onPosted={() => setPosted(true)} />
      )}
      {comment.replies.map((reply) => (
        <CommentNode key={reply.id} comment={reply} postId={postId} depth={depth + 1} />
      ))}
    </div>
  );
}
