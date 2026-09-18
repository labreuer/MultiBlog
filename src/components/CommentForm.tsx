"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { submitComment, type SubmitCommentState } from "@/app/actions/comments";
import {
  emptyCommentBodyValue,
  isCommentBodyValueEmpty,
  rememberedCommentBodyMode,
  type CommentBodyValue,
} from "@/lib/comment-body-value";
import { useCommentDraft } from "@/lib/use-comment-draft";
import CommentBodyInput from "./CommentBodyInput";
import styles from "./CommentForm.module.css";

const initialState: SubmitCommentState = {};

type Props = {
  postId: string;
  parentCommentId?: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  onPosted?: () => void;
  onCancel?: () => void;
};

// PLAN.md §23g — which composer a draft belongs to. A reply's key is its
// parent, a passage comment's is its range, and the general box is the post.
function draftKey(props: Props): string {
  if (props.parentCommentId) return `reply:${props.parentCommentId}`;
  if (props.anchorFrom !== undefined && props.anchorTo !== undefined) {
    return `post:${props.postId}:quote:${props.anchorFrom}-${props.anchorTo}`;
  }
  return `post:${props.postId}`;
}

export default function CommentForm(props: Props) {
  const { postId, parentCommentId, anchorFrom, anchorTo, quotedText, onPosted, onCancel } = props;
  const router = useRouter();
  const { data: session } = useSession();
  const userName = session?.user ? (session.user.name ?? session.user.email ?? null) : null;
  const [state, formAction, pending] = useActionState(submitComment, initialState);

  // Markdown on the server render, always — the remembered mode lives in
  // localStorage, which SSR cannot read, and a form whose first paint differs
  // from its HTML is a hydration mismatch. The effect below switches an
  // *empty* form to the remembered mode once mounted; a restored draft brings
  // its own mode with it.
  const [value, setValue] = useState<CommentBodyValue>(() => emptyCommentBodyValue("markdown"));
  useEffect(() => {
    const mode = rememberedCommentBodyMode();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from localStorage (an external system)
    setValue((current) => (isCommentBodyValueEmpty(current) && current.mode !== mode ? emptyCommentBodyValue(mode) : current));
  }, []);

  const draft = useCommentDraft(draftKey(props), value, setValue);

  useEffect(() => {
    if (state.status === "APPROVED" || state.status === "PENDING") {
      draft.clear();
    }
    if (state.status === "APPROVED") {
      onPosted?.();
      // The action revalidated the (statically generated) post page; this is
      // what fetches it, so the author sees their own comment without a
      // manual reload. Same call CommentNode makes after an edit or delete.
      router.refresh();
    }
  }, [state.status, onPosted, draft, router]);

  if (state.status === "APPROVED") {
    return null;
  }

  if (state.status === "PENDING") {
    return <p className={styles.status}>Your comment is awaiting moderation.</p>;
  }

  const empty = isCommentBodyValueEmpty(value);

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
      {/* The body crosses as two fields whichever door it came through —
          the textarea itself carries no name, so a mode switch cannot leave
          a stale field behind (docs/DOC_IMPORT.md §8's rule, restated). */}
      <input type="hidden" name="bodyFormat" value={value.mode} />
      <input
        type="hidden"
        name="body"
        value={value.mode === "markdown" ? value.markdown : value.json ? JSON.stringify(value.json) : ""}
      />
      <CommentBodyInput
        value={value}
        onChange={setValue}
        ariaLabel="Comment body"
        placeholder={userName ? `Commenting as ${userName}` : "Write a comment..."}
        disabled={pending}
        required
      />
      {draft.restored && (
        <p className={styles.draftLine}>
          Draft restored ·{" "}
          <button type="button" onClick={draft.discard} className={styles.draftDiscard}>
            discard
          </button>
        </p>
      )}
      {state.error && <p className={styles.error}>{state.error}</p>}
      <div className={styles.buttonRow}>
        <button
          type="submit"
          disabled={pending || empty}
          className={`${styles.submit} ${pending ? styles.submitPending : ""}`}
        >
          {pending ? "Posting..." : "Post comment"}
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
