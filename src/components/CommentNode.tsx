"use client";

import { useState } from "react";
import CommentForm from "./CommentForm";

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

  return (
    <div
      style={{
        marginLeft: depth > 0 ? 20 : 0,
        marginTop: 12,
        paddingLeft: depth > 0 ? 12 : 0,
        borderLeft: depth > 0 ? "2px solid #eee" : "none",
      }}
    >
      <p style={{ fontWeight: "bold", marginBottom: 2 }}>{comment.displayName}</p>
      <p style={{ color: "#666", fontSize: "0.8rem", marginBottom: 4 }}>
        {new Date(comment.createdAt).toLocaleString()}
      </p>
      <p>{comment.bodyText}</p>
      <button type="button" onClick={() => setReplying((r) => !r)} style={{ fontSize: "0.85rem" }}>
        {replying ? "Cancel" : "Reply"}
      </button>
      {replying && <CommentForm postId={postId} parentCommentId={comment.id} userName={userName} />}
      {comment.replies.map((reply) => (
        <CommentNode key={reply.id} comment={reply} postId={postId} userName={userName} depth={depth + 1} />
      ))}
    </div>
  );
}
