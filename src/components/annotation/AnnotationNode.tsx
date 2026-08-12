"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
// Aliased because the local `isAdmin` below is the resolved boolean for this
// viewer; role-checks.ts is safe in a client bundle by design (its own header
// says so — authz.ts is not, since it imports prisma).
import { isAdmin as isAdminRole } from "@/lib/role-checks";
import LocalTime from "../LocalTime";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import { deleteAnnotation, createDraftAnnotation } from "@/app/actions/annotations";
import styles from "./AnnotationNode.module.css";

export type AnnotationNodeData = {
  id: string;
  displayName: string;
  // Rendered server-side from proseJson (PLAN.md §13j Phase 2) — a static
  // rendering, same @tiptap/static-renderer call the doc reading view
  // already uses, not a live editor. Only an actively-open composer
  // (LiveAnnotationComposer) is ever connected to an annotation's ydoc.
  body: ReactNode;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
  replies: AnnotationNodeData[];
};

type Props = {
  annotation: AnnotationNodeData;
  docId: string;
  depth?: number;
};

// A permalink id for the annotation — down to the second is enough that a
// collision would mean the same person annotated twice in the same second,
// which shouldn't happen; not worth guarding.
function anchorName(displayName: string, createdAt: string): string {
  const name = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const timestamp = new Date(createdAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${name || "annotation"}-${timestamp}`;
}

// Whether any annotation anywhere below this one (not just direct replies)
// is still live — a deleted annotation with no live descendants collapses
// entirely rather than leaving a "[deleted]" placeholder with nothing under it.
export function hasNonDeletedDescendant(annotation: AnnotationNodeData): boolean {
  return annotation.replies.some((reply) => reply.deletedByUserId === null || hasNonDeletedDescendant(reply));
}

// The doc-side sibling of CommentNode (PLAN.md §13c) — un-shared from it now
// that an annotation and a post comment no longer share a rendering problem.
export default function AnnotationNode({ annotation, docId, depth = 0 }: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  const viewerId = session?.user?.id ?? null;
  const isAdmin = !!session?.user && isAdminRole(session.user.role);
  // A reply's own DRAFT id, once "Reply" has created one (PLAN.md §13j
  // Phase 2) — null means the reply composer isn't open. Unlike the old
  // plain-textarea CommentForm, there's no separate "replying" boolean:
  // LiveAnnotationComposer needs a real row to connect to before it can
  // render anything, so "open" and "has a draft id" are the same state.
  const [replyDraftId, setReplyDraftId] = useState<string | null>(null);
  const [replyPending, startReplyTransition] = useTransition();
  const [replyError, setReplyError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, startDeleteTransition] = useTransition();
  // Set only by this viewer's own click on "Yes" below — overrides the
  // collapse-to-nothing behavior so deleting your own annotation gets
  // visible "[deleted]" feedback instead of it just silently vanishing. A
  // fresh page load never sets this, so the collapse rule still applies there.
  const [justDeleted, setJustDeleted] = useState(false);
  const anchorId = anchorName(annotation.displayName, annotation.createdAt);
  const isDeleted = annotation.deletedByUserId !== null || justDeleted;

  if (isDeleted && !justDeleted && !hasNonDeletedDescendant(annotation)) {
    return null;
  }

  const isOwnAnnotation = viewerId !== null && annotation.commenterUserId === viewerId;
  const canDelete = isAdmin || isOwnAnnotation;
  // Admin power being used on someone else's annotation gets a visibly
  // different (maroon) button; deleting your own, even as an admin, is just
  // the normal action.
  const isAdminOnOthers = isAdmin && !isOwnAnnotation;

  const handleDelete = () => {
    setDeleteError(null);
    startDeleteTransition(async () => {
      try {
        await deleteAnnotation(annotation.id);
        setJustDeleted(true);
        router.refresh();
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : "Failed to delete annotation.");
      }
    });
  };

  const openReply = () => {
    setReplyError(null);
    startReplyTransition(async () => {
      const result = await createDraftAnnotation(docId, annotation.id);
      if ("error" in result) {
        setReplyError(result.error);
        return;
      }
      setReplyDraftId(result.id);
    });
  };

  return (
    <div className={`${styles.node} ${depth > 0 ? styles.nested : ""}`}>
      {isDeleted ? (
        <div className={styles.deleted} data-comment-id={annotation.id}>
          [deleted]
        </div>
      ) : (
        <div data-comment-id={annotation.id}>
          <p className={styles.meta}>
            <span className={styles.name}>{annotation.displayName}</span>
            <a id={anchorId} href={`#${anchorId}`} className={styles.timestamp}>
              <LocalTime value={annotation.createdAt} />
            </a>
          </p>
          <div>{annotation.body}</div>
          {!posted && !replyDraftId && (
            <button type="button" onClick={openReply} disabled={replyPending} className={styles.replyButton}>
              {replyPending ? "Opening…" : "Reply"}
            </button>
          )}
          {replyError && <p className={styles.error}>{replyError}</p>}
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
      {replyDraftId && !posted && (
        <LiveAnnotationComposer
          annotationId={replyDraftId}
          onPosted={() => {
            setPosted(true);
            setReplyDraftId(null);
          }}
          onCancel={() => setReplyDraftId(null)}
        />
      )}
      {annotation.replies.map((reply) => (
        <AnnotationNode key={reply.id} annotation={reply} docId={docId} depth={depth + 1} />
      ))}
    </div>
  );
}
