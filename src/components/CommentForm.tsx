"use client";

import { useActionState, useEffect } from "react";
import { submitComment, type SubmitCommentState } from "@/app/actions/comments";
import styles from "./CommentForm.module.css";

const initialState: SubmitCommentState = {};

type Props = {
  postId: string;
  parentCommentId?: string;
  userName: string | null;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  onPosted?: () => void;
};

export default function CommentForm({
  postId,
  parentCommentId,
  userName,
  anchorFrom,
  anchorTo,
  quotedText,
  onPosted,
}: Props) {
  const [state, formAction, pending] = useActionState(submitComment, initialState);

  useEffect(() => {
    if (state.status === "APPROVED") {
      onPosted?.();
    }
  }, [state.status, onPosted]);

  if (state.status === "APPROVED") {
    return null;
  }

  if (state.status === "PENDING") {
    return <p className={styles.status}>Your comment is awaiting moderation.</p>;
  }

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="postId" value={postId} />
      {parentCommentId && <input type="hidden" name="parentCommentId" value={parentCommentId} />}
      {anchorFrom !== undefined && anchorTo !== undefined && quotedText && (
        <>
          <input type="hidden" name="anchorFrom" value={anchorFrom} />
          <input type="hidden" name="anchorTo" value={anchorTo} />
          <input type="hidden" name="quotedText" value={quotedText} />
        </>
      )}
      {!userName && (
        <>
          <input name="name" type="text" placeholder="Name" required className={styles.field} />
          <input name="email" type="email" placeholder="Email" required className={styles.field} />
        </>
      )}
      <textarea
        name="body"
        placeholder={userName ? `Commenting as ${userName}` : "Write a comment..."}
        required
        rows={3}
        className={`${styles.field} ${styles.textarea}`}
      />
      {state.error && <p className={styles.error}>{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className={`${styles.submit} ${pending ? styles.submitPending : ""}`}
      >
        {pending ? "Posting..." : "Post comment"}
      </button>
    </form>
  );
}
