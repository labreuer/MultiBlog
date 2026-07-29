"use client";

import { useActionState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { submitComment, type SubmitCommentState } from "@/app/actions/comments";
import { submitAnnotation } from "@/app/actions/annotations";
import type { CommentTarget } from "@/lib/comment-data";
import styles from "./CommentForm.module.css";

const initialState: SubmitCommentState = {};

type Props = {
  target: CommentTarget;
  parentCommentId?: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  onPosted?: () => void;
  onCancel?: () => void;
};

export default function CommentForm({
  target,
  parentCommentId,
  anchorFrom,
  anchorTo,
  quotedText,
  onPosted,
  onCancel,
}: Props) {
  const { data: session } = useSession();
  const userName = session?.user ? (session.user.name ?? session.user.email ?? null) : null;
  // target.kind is fixed for this component instance's whole lifetime (set
  // once by its parent, never toggled in place), so this ternary is a
  // stable action reference across re-renders — exactly what useActionState
  // expects. submitAnnotation returns the same SubmitCommentState shape
  // (§12i: an annotation is "inserted immediately visible", the same
  // meaning CommentForm's APPROVED branch below already has).
  const action = target.kind === "post" ? submitComment : submitAnnotation;
  const [state, formAction, pending] = useActionState(action, initialState);

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
      <input type="hidden" name={target.kind === "post" ? "postId" : "docId"} value={target.id} />
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
        placeholder={
          target.kind === "doc"
            ? userName
              ? `Annotating as ${userName}`
              : "Write an annotation..."
            : userName
              ? `Commenting as ${userName}`
              : "Write a comment..."
        }
        required
        rows={3}
        className={`${styles.field} ${styles.textarea}`}
      />
      {state.error && <p className={styles.error}>{state.error}</p>}
      <div className={styles.buttonRow}>
        <button
          type="submit"
          disabled={pending}
          className={`${styles.submit} ${pending ? styles.submitPending : ""}`}
        >
          {target.kind === "doc"
            ? pending
              ? "Annotating..."
              : "Post annotation"
            : pending
              ? "Posting..."
              : "Post comment"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={styles.cancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
