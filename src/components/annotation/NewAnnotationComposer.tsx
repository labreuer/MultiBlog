"use client";

import { useEffect, useState, useTransition } from "react";
import { createDraftAnnotation, postAnnotation, discardDraftAnnotation } from "@/app/actions/annotations";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import { useAnnotationMove } from "./annotation-move-context";
import type { AnnotationTarget } from "@/lib/annotation-container";
import styles from "./AnnotationComposer.module.css";

// PLAN.md §19 — a container rather than a doc id, so the same composer serves
// /doc/[slug] and /pdf/[slug]. `pdfTarget` is set only by the PDF surface,
// which opens this composer with a selection already captured.
type Props = { target: AnnotationTarget; pdfTarget?: unknown };

type OpenDraft = { id: string; anchorFrom?: number; anchorTo?: number; quotedText?: string };

// The bottom-of-page composer's open/closed wrapper (PLAN.md §13j Phase 2) —
// AnnotationSection is a server component and can't hold the "have I
// created my draft yet" state itself, so this is the client boundary.
// Collapsed by default (a placeholder trigger, not a live editor sitting
// open on every page load): opening it creates a DRAFT eagerly, same
// reasoning §13d gives for why a composer needs a row before a single
// keystroke lands.
export default function NewAnnotationComposer({ target, pdfTarget }: Props) {
  const [open, setOpen] = useState<OpenDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { movedDraft, setMovedDraft } = useAnnotationMove();

  // PLAN.md §13g — "Move to bottom" hands this slot an already-created
  // draft (same row, same ydoc, nothing copied). If this slot already had
  // its own draft open, it's committed first — posted, quiet,
  // document-level — rather than silently discarded for the incoming one;
  // an empty previous draft has nothing worth keeping, so a post that fails
  // because it's empty falls back to discarding it instead.
  useEffect(() => {
    if (!movedDraft) return;
    const incoming = movedDraft;
    const previous = open;
    setMovedDraft(null);
    startTransition(async () => {
      if (previous) {
        const result = await postAnnotation({
          annotationId: previous.id,
          anchorFrom: previous.anchorFrom,
          anchorTo: previous.anchorTo,
          quotedText: previous.quotedText,
        });
        if (result.error) {
          await discardDraftAnnotation(previous.id).catch(() => {});
        }
      }
      setOpen({
        id: incoming.id,
        anchorFrom: incoming.anchorFrom,
        anchorTo: incoming.anchorTo,
        quotedText: incoming.quotedText,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open`/startTransition are read at fire time, not tracked as retrigger deps for this cross-tree signal
  }, [movedDraft, setMovedDraft]);

  function openNew() {
    setError(null);
    startTransition(async () => {
      const result = await createDraftAnnotation(target);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen({ id: result.id });
    });
  }

  if (open) {
    return (
      <LiveAnnotationComposer
        annotationId={open.id}
        anchorFrom={open.anchorFrom}
        anchorTo={open.anchorTo}
        quotedText={open.quotedText}
        pdfTarget={pdfTarget}
        onPosted={() => setOpen(null)}
        onCancel={() => setOpen(null)}
      />
    );
  }

  return (
    <div>
      <button type="button" onClick={openNew} disabled={pending} className={`${styles.field} ${styles.placeholder}`}>
        {pending ? "Opening…" : "Write an annotation..."}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
