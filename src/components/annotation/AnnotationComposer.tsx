"use client";

import { useActionState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { submitAnnotation } from "@/app/actions/annotations";
import type { SubmitCommentState } from "@/app/actions/comments";
import styles from "./AnnotationComposer.module.css";

const initialState: SubmitCommentState = {};

type Props = {
  docId: string;
  parentAnnotationId?: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  onPosted?: () => void;
  onCancel?: () => void;
};

// The doc-side sibling of CommentForm (PLAN.md §13c) — un-shared from it now
// that an annotation body is becoming its own collaborative document rather
// than a plain textarea. Still a plain `<textarea>` posting through
// submitAnnotation until Phase 2 replaces it with a live ydoc editor; this
// phase only separates the component, not the interaction.
export default function AnnotationComposer({
  docId,
  parentAnnotationId,
  anchorFrom,
  anchorTo,
  quotedText,
  onPosted,
  onCancel,
}: Props) {
  const { data: session } = useSession();
  const userName = session?.user ? (session.user.name ?? session.user.email ?? null) : null;
  const [state, formAction, pending] = useActionState(submitAnnotation, initialState);

  useEffect(() => {
    if (state.status === "APPROVED") {
      onPosted?.();
    }
  }, [state.status, onPosted]);

  if (state.status === "APPROVED") {
    return null;
  }

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="docId" value={docId} />
      {parentAnnotationId && <input type="hidden" name="parentCommentId" value={parentAnnotationId} />}
      {anchorFrom !== undefined && anchorTo !== undefined && quotedText && (
        <>
          <input type="hidden" name="anchorFrom" value={anchorFrom} />
          <input type="hidden" name="anchorTo" value={anchorTo} />
          <input type="hidden" name="quotedText" value={quotedText} />
        </>
      )}
      <textarea
        name="body"
        placeholder={userName ? `Annotating as ${userName}` : "Write an annotation..."}
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
          {pending ? "Annotating..." : "Post annotation"}
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
