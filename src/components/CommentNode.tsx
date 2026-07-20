"use client";

import { useState } from "react";
import CommentForm from "./CommentForm";
import styles from "./CommentNode.module.css";

export type CommentNodeData = {
  id: string;
  displayName: string;
  bodyText: string;
  createdAt: string;
  replies: CommentNodeData[];
};

type Props = {
  comment: CommentNodeData;
  postId: string;
  userName: string | null;
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

export default function CommentNode({ comment, postId, userName, depth = 0 }: Props) {
  const [replying, setReplying] = useState(false);
  const [posted, setPosted] = useState(false);
  const anchorId = anchorName(comment.displayName, comment.createdAt);

  return (
    <div className={`${styles.node} ${depth > 0 ? styles.nested : ""}`}>
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
      {replying && !posted && (
        <CommentForm
          postId={postId}
          parentCommentId={comment.id}
          userName={userName}
          onPosted={() => setPosted(true)}
        />
      )}
      {comment.replies.map((reply) => (
        <CommentNode key={reply.id} comment={reply} postId={postId} userName={userName} depth={depth + 1} />
      ))}
    </div>
  );
}
