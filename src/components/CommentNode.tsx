"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
// Aliased because the local `isAdmin` below is the resolved boolean for this
// viewer; role-checks.ts is safe in a client bundle by design (its own header
// says so — authz.ts is not, since it imports prisma).
import { canEditAnyPost, isAdmin as isAdminRole } from "@/lib/role-checks";
import LocalTime from "./LocalTime";
import CommentForm from "./CommentForm";
import CommentBody from "./CommentBody";
import CommentBodyInput from "./CommentBodyInput";
import EditHistory from "./EditHistory";
import {
  deleteComment,
  editComment,
  getCommentHistory,
  getCommentMarkdown,
  type CommentVersion,
} from "@/app/actions/comments";
import {
  commentBodyValuePendingJSON,
  commentBodyValueToInput,
  isCommentBodyValueEmpty,
  rememberedCommentBodyMode,
  type CommentBodyValue,
} from "@/lib/comment-body-value";
import { useCommentQuote } from "./comment-quote-context";
import type { JSONContent } from "@tiptap/core";
import type { CommentQuoteCitations } from "@/lib/comment-quote-citation";
import styles from "./CommentNode.module.css";

export type CommentNodeData = {
  id: string;
  displayName: string;
  // PLAN.md §23b — the stored document, rendered by CommentBody; bodyText is
  // the same words plain, for the fallback and for anything text-shaped.
  body: unknown;
  bodyText: string;
  // PLAN.md §23h — resolved server-side by the loader; keyed by anchor id.
  citations: CommentQuoteCitations;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
  // PLAN.md §22b — resolved by the loader (comment-data.ts), not here: the
  // silence rule needs every revision's timestamp, and a client deciding it
  // would need them shipped. `editedAt` is null whenever visiblyEdited is
  // false, including for a comment that really was edited silently.
  visiblyEdited: boolean;
  editedAt: string | null;
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
  const isAdmin = !!session?.user && isAdminRole(session.user.role);
  const [replying, setReplying] = useState(false);
  const [posted, setPosted] = useState(false);
  // PLAN.md §23h — "Quote in reply" on a closed reply form: the page's quote
  // context asks this card to open it, and delivers once the form registers.
  const quoteContext = useCommentQuote();
  useEffect(() => {
    if (!quoteContext) return;
    return quoteContext.registerOpener(`reply:${comment.id}`, () => setReplying(true));
  }, [quoteContext, comment.id]);
  const [editing, setEditing] = useState(false);
  // The edit box's value in either mode (PLAN.md §23m). Null while the
  // Markdown serialization is being fetched — the stored form is JSON, and
  // the Markdown for the box comes from the server on demand.
  const [draft, setDraft] = useState<CommentBodyValue | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, startEditTransition] = useTransition();
  // Set by this viewer's own successful save, and shown in place of the
  // server's copy until a refresh lands. Not an optimistic update — the save
  // has already succeeded — but the same reason `justDeleted` exists: the
  // post page is statically generated (PLAN.md §21), so the revalidation and
  // the refresh that follow are a round trip the author should not have to
  // watch to see their own words.
  const [saved, setSaved] = useState<{ body: JSONContent; bodyText: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, startDeleteTransition] = useTransition();
  // Set only by this viewer's own click on "Yes" below — overrides the
  // collapse-to-nothing behavior so deleting your own comment gets visible
  // "[deleted]" feedback instead of it just silently vanishing. A fresh page
  // load never sets this, so the collapse rule still applies there.
  const [justDeleted, setJustDeleted] = useState(false);
  // True only while the history panel is listing versions. The current
  // version is the first of them, so the body below would be the same text a
  // second time; it comes back the moment the panel closes. Set from
  // `EditHistory` rather than from a click here because the panel has states
  // — loading, failed, nothing the viewer may see — in which it stands in for
  // nothing and the body has to stay.
  const [historyShown, setHistoryShown] = useState(false);
  const anchorId = anchorName(comment.displayName, comment.createdAt);
  const isDeleted = comment.deletedByUserId !== null || justDeleted;

  if (isDeleted && !justDeleted && !hasNonDeletedDescendant(comment)) {
    return null;
  }

  const isOwnComment = viewerId !== null && comment.commenterUserId === viewerId;
  const canDelete = isAdmin || isOwnComment;
  // PLAN.md §22f — the author, or someone who moderates the post. The
  // *action* asks `canUserEditPost`, which also admits an AUTHOR moderating
  // their own post; this control cannot, because the page it renders on is
  // statically generated and so knows nothing about the viewer beyond their
  // session (§22c records the gap). A control that is absent is not a
  // permission error, and the two admin surfaces reach every comment anyway.
  const canEdit = isOwnComment || (!!session?.user && canEditAnyPost(session.user.role));
  const body = saved?.body ?? comment.body;
  const bodyText = saved?.bodyText ?? comment.bodyText;
  // Admin power being used on someone else's comment gets a visibly
  // different (maroon) button; deleting your own comment, even as an
  // admin, is just the normal action.
  const isAdminOnOthers = isAdmin && !isOwnComment;

  // Opens the box in the browser's remembered mode. Rich mode edits the
  // stored JSON directly; Markdown mode asks the server for the serialization
  // first, so the box is briefly absent rather than briefly wrong.
  const handleStartEdit = () => {
    setEditError(null);
    setEditing(true);
    if (rememberedCommentBodyMode() === "rich") {
      setDraft({ mode: "rich", json: body as JSONContent });
      return;
    }
    setDraft(null);
    startEditTransition(async () => {
      const result = await getCommentMarkdown(comment.id);
      if ("error" in result) {
        setEditError(result.error);
        setEditing(false);
        return;
      }
      setDraft({ mode: "markdown", markdown: result.markdown });
    });
  };

  const handleSaveEdit = () => {
    if (!draft || isCommentBodyValueEmpty(draft)) return;
    setEditError(null);
    startEditTransition(async () => {
      const result = await editComment(comment.id, commentBodyValueToInput(draft), commentBodyValuePendingJSON(draft));
      if (result.error) {
        setEditError(result.error);
        return;
      }
      if (result.body && result.bodyText !== undefined) {
        setSaved({ body: result.body, bodyText: result.bodyText });
      }
      setEditing(false);
      if (result.status === "SPAM") {
        // The edit was saved and the comment was withdrawn from public view
        // (§22c). Saying so is the whole point: the author would otherwise
        // watch their words vanish from the page with no explanation.
        setEditError("Saved, but this comment has been flagged for moderation and is no longer public.");
      }
      router.refresh();
    });
  };

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
          <div className={styles.meta}>
            <span className={styles.name}>{comment.displayName}</span>
            <a id={anchorId} href={`#${anchorId}`} className={styles.timestamp}>
              <LocalTime value={comment.createdAt} />
            </a>
            {comment.visiblyEdited && (
              <>
                {" "}
                <EditHistory
                  what="comment"
                  placement="meta"
                  onVersionsShown={setHistoryShown}
                  editedAt={comment.editedAt}
                  load={() => getCommentHistory(comment.id)}
                  renderBody={(version: CommentVersion) => (
                    <CommentBody body={version.body} bodyText={version.bodyText} citations={comment.citations} />
                  )}
                />
              </>
            )}
          </div>
          {editing ? (
            <div className={styles.editForm}>
              {draft ? (
                <CommentBodyInput
                  value={draft}
                  onChange={setDraft}
                  ariaLabel="Edit comment"
                  disabled={editPending}
                  rows={4}
                  autoFocus
                  composerKey={`edit:${comment.id}`}
                />
              ) : (
                <p className={styles.editLoading}>Loading…</p>
              )}
              <span className={styles.editActions}>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={editPending || !draft || isCommentBodyValueEmpty(draft)}
                  className={styles.confirmYes}
                >
                  {editPending ? "Saving…" : "Save"}
                </button>{" "}
                /{" "}
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(null);
                    setEditError(null);
                  }}
                  disabled={editPending}
                  className={styles.confirmNo}
                >
                  Cancel
                </button>
              </span>
            </div>
          ) : (
            !historyShown && (
              <div data-comment-body>
                <CommentBody body={body} bodyText={bodyText} citations={comment.citations} />
              </div>
            )
          )}
          {!posted && !editing && (
            <button type="button" onClick={() => setReplying((r) => !r)} className={styles.replyButton}>
              {replying ? "Cancel" : "Reply"}
            </button>
          )}
          {canEdit && !editing && !confirmingDelete && (
            <button type="button" onClick={handleStartEdit} className={styles.editButton}>
              Edit
            </button>
          )}
          {canDelete && !editing && !confirmingDelete && (
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
          {editError && <p className={styles.error}>{editError}</p>}
          {deleteError && <p className={styles.error}>{deleteError}</p>}
        </div>
      )}
      {replying && !posted && (
        <div data-reply-form={comment.id}>
          <CommentForm postId={postId} parentCommentId={comment.id} onPosted={() => setPosted(true)} />
        </div>
      )}
      {comment.replies.map((reply) => (
        <CommentNode key={reply.id} comment={reply} postId={postId} depth={depth + 1} />
      ))}
    </div>
  );
}
