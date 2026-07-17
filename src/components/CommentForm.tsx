"use client";

import { useActionState } from "react";
import { submitComment, type SubmitCommentState } from "@/app/actions/comments";

const initialState: SubmitCommentState = {};

type Props = {
  postId: string;
  parentCommentId?: string;
  userName: string | null;
};

export default function CommentForm({ postId, parentCommentId, userName }: Props) {
  const [state, formAction, pending] = useActionState(submitComment, initialState);

  if (state.status) {
    return (
      <p style={{ color: "#666" }}>
        {state.status === "APPROVED" ? "Comment posted." : "Your comment is awaiting moderation."}
      </p>
    );
  }

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <input type="hidden" name="postId" value={postId} />
      {parentCommentId && <input type="hidden" name="parentCommentId" value={parentCommentId} />}
      {!userName && (
        <>
          <input name="name" type="text" placeholder="Name" required />
          <input name="email" type="email" placeholder="Email" required />
        </>
      )}
      <textarea
        name="body"
        placeholder={userName ? `Commenting as ${userName}` : "Write a comment..."}
        required
        rows={3}
      />
      {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
      <button type="submit" disabled={pending} style={{ alignSelf: "flex-start" }}>
        {pending ? "Posting..." : "Post comment"}
      </button>
    </form>
  );
}
