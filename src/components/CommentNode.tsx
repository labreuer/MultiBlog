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

export default function CommentNode({ comment, postId, userName, depth = 0 }: Props) {
  const [replying, setReplying] = useState(false);
  const [posted, setPosted] = useState(false);

  return (
    <div className={`${styles.node} ${depth > 0 ? styles.nested : ""}`}>
      <p className={styles.meta}>
        <span className={styles.name}>{comment.displayName}</span>
        <span className={styles.timestamp}>{new Date(comment.createdAt).toLocaleString()}</span>
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
