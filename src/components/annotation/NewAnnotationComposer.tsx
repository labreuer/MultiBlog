"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createDraftAnnotation, postAnnotation, discardDraftAnnotation } from "@/app/actions/annotations";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import { useAnnotationMove } from "./annotation-move-context";
import { useAnnotationReload } from "./annotation-reload-context";
import type { AnnotationTarget } from "@/lib/annotation-container";
import styles from "./AnnotationComposer.module.css";

// PLAN.md §19 — a container rather than a doc id, so the same composer serves
// /doc/[slug] and /pdf/[slug]. `pdfTarget` is set only by the PDF surface,
// which opens this composer with a selection already captured.
type Props = {
  target: AnnotationTarget;
  pdfTarget?: unknown;
  /**
   * Open the editor immediately on mount instead of showing the collapsed
   * placeholder (PLAN.md §19).
   *
   * Set by the PDF panel, whose composer is opened *by a gesture somewhere
   * else* — the "Annotate" control floating over the selection. Without this
   * the reader clicks Annotate, the capture succeeds silently, and the only
   * visible result is a placeholder in a side panel they then have to find and
   * click again. The doc side needs none of it: its composer opens where the
   * selection is, so the click and the editor are in the same place.
   */
  autoOpen?: boolean;
  /**
   * The composer finished with the selection it was opened for — posted,
   * saved privately, or cancelled.
   *
   * The PDF panel uses it to drop the captured anchor, so a later "Write an
   * annotation…" starts unanchored instead of silently inheriting the previous
   * selection's target.
   */
  onSettled?: () => void;
};

type OpenDraft = { id: string; anchorFrom?: number; anchorTo?: number; quotedText?: string };

// The bottom-of-page composer's open/closed wrapper (PLAN.md §13j Phase 2) —
// AnnotationSection is a server component and can't hold the "have I
// created my draft yet" state itself, so this is the client boundary.
// Collapsed by default (a placeholder trigger, not a live editor sitting
// open on every page load): opening it creates a DRAFT eagerly, same
// reasoning §13d gives for why a composer needs a row before a single
// keystroke lands.
export default function NewAnnotationComposer({ target, pdfTarget, autoOpen = false, onSettled }: Props) {
  const [open, setOpen] = useState<OpenDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { movedDraft, setMovedDraft } = useAnnotationMove();
  const reloadAnnotations = useAnnotationReload();

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

  const openNew = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await createDraftAnnotation(target);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen({ id: result.id });
    });
  }, [target]);

  // Fires once per mount. The PDF panel remounts this component (a fresh
  // `key`) on every capture, so "once per mount" is exactly once per selection
  // — including a second selection of the same text, which an effect keyed on
  // the target's value could not distinguish from a re-render.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    openNew();
  }, [autoOpen, openNew]);

  if (open) {
    return (
      <LiveAnnotationComposer
        annotationId={open.id}
        anchorFrom={open.anchorFrom}
        anchorTo={open.anchorTo}
        quotedText={open.quotedText}
        pdfTarget={pdfTarget}
        container={target.kind}
        onPosted={() => {
          setOpen(null);
          onSettled?.();
          // Narrower than onSettled deliberately: that one also fires on a
          // cancel and on a private save, neither of which changes the list
          // any surface is drawing.
          reloadAnnotations();
        }}
        onCancel={() => {
          setOpen(null);
          onSettled?.();
        }}
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
