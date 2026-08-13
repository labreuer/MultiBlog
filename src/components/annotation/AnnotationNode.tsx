"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { JSONContent } from "@tiptap/react";
import { annotationAnchorInputs } from "@/lib/annotation-highlight-extension";
import { flashHighlight } from "@/lib/flash-highlight";
import { NEUTRAL_THREAD_COLOR } from "@/lib/author-colors";
// Aliased because the local `isAdmin` below is the resolved boolean for this
// viewer; role-checks.ts is safe in a client bundle by design (its own header
// says so — authz.ts is not, since it imports prisma).
import { isAdmin as isAdminRole } from "@/lib/role-checks";
import LocalTime from "../LocalTime";
import AnnotationBodyReader, { type BodySelection } from "./AnnotationBodyReader";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import { deleteAnnotation, createDraftAnnotation } from "@/app/actions/annotations";
import { useDocScrub } from "../DocScrubContext";
import styles from "./AnnotationNode.module.css";

export type AnnotationNodeData = {
  id: string;
  displayName: string;
  // Rendered server-side from proseJson (PLAN.md §13j Phase 2) — a static
  // rendering, same @tiptap/static-renderer call the doc reading view
  // already uses, not a live editor. Only an actively-open composer
  // (LiveAnnotationComposer) is ever connected to an annotation's ydoc.
  // Since §13p this is the pre-ready and no-JS copy rather than the whole
  // rendering; AnnotationBodyReader swaps in an equivalent read-only editor
  // once it mounts, which is what makes a body selectable.
  body: ReactNode;
  // The JSON that tree was rendered from — see §13p and annotation-entries.ts.
  proseJson: JSONContent | null;
  // PLAN.md §13p — this annotation's own anchor into its *parent's* body, if
  // it is a reply that was made from a selection. Read by the parent, not by
  // the node itself: it is what tells the parent's body which range to
  // highlight in this reply's color.
  anchorFrom: number | null;
  anchorTo: number | null;
  quotedText: string;
  color: string;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
  // PLAN.md §12p/§13 — which ydoc_update this was posted against, or null
  // for a row from before the column existed. Metadata, not an anchor —
  // drives the "at this revision" control below, nothing else.
  ydocUpdateId: string | null;
  replies: AnnotationNodeData[];
};

type Props = {
  annotation: AnnotationNodeData;
  docId: string;
  depth?: number;
};

// How long a selection has to stop changing before it is worth a DRAFT row
// (PLAN.md §13p). Long enough that dragging across a sentence is one row and
// not thirty; short enough that it still reads as "selecting opened a reply".
const SELECTION_SETTLE_MS = 300;

// Clicking a highlighted range inside an annotation's body scrolls to the
// reply that quoted it and flashes the card — the in-body counterpart of
// DocReadingBody's jumpToAnnotationEntry, keyed on `data-comment-id` (which
// every rendered annotation already carries) rather than on a thread id,
// since a reply is not a thread of its own.
function jumpToReply(replyIds: string[]) {
  const id = replyIds[0];
  if (!id) return;
  const target = document.querySelector<HTMLElement>(`[data-comment-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  flashHighlight(target, NEUTRAL_THREAD_COLOR);
}

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
  // The composing reader's own color, for the pending decoration (PLAN.md
  // §13f's convention: a not-yet-posted range is colored by whoever is making
  // it, since there is no annotation to take a color from yet). Null before
  // the client-side session resolves, which just means no decoration for that
  // moment rather than a wrongly-colored one.
  const viewerColor = session?.user?.color ?? null;
  const isAdmin = !!session?.user && isAdminRole(session.user.role);
  // A reply's own DRAFT id, once "Reply" has created one (PLAN.md §13j
  // Phase 2) — null means the reply composer isn't open. Unlike the old
  // plain-textarea CommentForm, there's no separate "replying" boolean:
  // LiveAnnotationComposer needs a real row to connect to before it can
  // render anything, so "open" and "has a draft id" are the same state.
  const [replyDraftId, setReplyDraftId] = useState<string | null>(null);
  const [replyPending, startReplyTransition] = useTransition();
  const [replyError, setReplyError] = useState<string | null>(null);
  // PLAN.md §13p — the range in *this* annotation's body that the open (or
  // about-to-open) reply quotes. Set the instant a selection is made, so the
  // decoration appears with no wait; the draft row it eventually belongs to
  // is created on the debounce below.
  const [replyAnchor, setReplyAnchor] = useState<BodySelection | null>(null);
  const [posted, setPosted] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, startDeleteTransition] = useTransition();
  // Set only by this viewer's own click on "Yes" below — overrides the
  // collapse-to-nothing behavior so deleting your own annotation gets
  // visible "[deleted]" feedback instead of it just silently vanishing. A
  // fresh page load never sets this, so the collapse rule still applies there.
  const [justDeleted, setJustDeleted] = useState(false);
  // Null outside a DocScrubProvider (the doc editor's rail has none) or
  // before the reading view's scrub bar has been touched at all — both
  // supported states, see useDocScrub's own note.
  const seekToUpdateId = useDocScrub();
  // PLAN.md §13p — the DRAFT row a selection eventually opens waits for the
  // selection to settle, so the timer that decides "settled" needs somewhere
  // to live. Declared up here with the other hooks, above the early return
  // below, since hook order has to be identical on every render — including
  // the renders where this node collapses to nothing.
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
    },
    [],
  );

  // Each direct reply that quotes part of this body, in its own author's
  // color. Only direct replies: an anchor points at the annotation it answers,
  // so a reply-of-a-reply is drawn inside *its* parent's body, by that node.
  const replyAnchors = useMemo(
    () =>
      annotationAnchorInputs(
        annotation.replies
          .filter((reply) => reply.deletedByUserId === null)
          .map((reply) => ({
            threadId: reply.id,
            quotedText: reply.quotedText,
            anchorFrom: reply.anchorFrom,
            anchorTo: reply.anchorTo,
            color: reply.color,
          })),
      ),
    [annotation.replies],
  );

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

  // PLAN.md §13p — selecting text in this annotation's body *is* the request
  // to reply to it, the same way selecting text in the doc is the request to
  // annotate the doc. Two states, and the difference between them is the
  // whole feature:
  //
  //  - **No reply open** → open one, anchored here.
  //  - **A reply already open** → re-point it. Not a second composer: the
  //    reader is refining what they are replying *about*, not starting a
  //    second reply, and opening one per selection adjustment would leave a
  //    trail of abandoned DRAFT rows behind a single change of mind.
  //
  // The anchor lands in state immediately (the decoration is free), but the
  // DRAFT row waits for the selection to settle — a drag emits a selection
  // update per pixel, and each one would otherwise be a row, a ydoc, and a
  // websocket. A timer rather than pointerup, so a keyboard selection
  // (shift+arrows, which never emits one) settles the same way.
  const handleBodySelect = (selection: BodySelection) => {
    setReplyAnchor(selection);
    if (replyDraftId || posted) return;
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    openTimerRef.current = setTimeout(openReply, SELECTION_SETTLE_MS);
  };

  const closeReply = () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    setReplyDraftId(null);
    setReplyAnchor(null);
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
            {annotation.ydocUpdateId && seekToUpdateId && (
              <button
                type="button"
                className={styles.revisionButton}
                title="Scrub the reading view back to this annotation's revision"
                onClick={() => seekToUpdateId(annotation.ydocUpdateId!)}
              >
                at this revision
              </button>
            )}
          </p>
          <AnnotationBodyReader
            proseJson={annotation.proseJson}
            staticBody={annotation.body}
            replyAnchors={replyAnchors}
            pending={
              replyAnchor && viewerColor
                ? { from: replyAnchor.from, to: replyAnchor.to, color: viewerColor }
                : null
            }
            onSelect={handleBodySelect}
            onAnchorClick={jumpToReply}
          />
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
          // Read at submit time, so re-selecting while this sits open changes
          // what the reply ends up quoting (PLAN.md §13p). Undefined when the
          // reply was opened from the Reply button and no selection followed —
          // an anchorless reply, exactly as before.
          anchorFrom={replyAnchor?.from}
          anchorTo={replyAnchor?.to}
          quotedText={replyAnchor?.quotedText}
          onPosted={() => {
            setPosted(true);
            closeReply();
          }}
          onCancel={closeReply}
        />
      )}
      {annotation.replies.map((reply) => (
        <AnnotationNode key={reply.id} annotation={reply} docId={docId} depth={depth + 1} />
      ))}
    </div>
  );
}
