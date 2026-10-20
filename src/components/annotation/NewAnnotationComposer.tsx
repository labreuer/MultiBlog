"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createDraftAnnotation, postAnnotation, discardDraftAnnotation } from "@/app/actions/annotations";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import { useAnnotationMove } from "./annotation-move-context";
import { useAnnotationReload } from "./annotation-reload-context";
import type { AnnotationTarget } from "@/lib/annotation-container";
import type { AnnotationConnectionBundle } from "@/lib/annotation-connection";
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

// `connection` is present only for a draft this slot created itself
// (annotation-connection.ts) — a draft that arrived by "Move to bottom" was
// created in another component's action, so the composer fetches its own.
//
// So is `pdfTarget`: the selection this slot's own draft was opened on, kept
// per draft rather than read from the prop at post time, so a draft that
// arrives from "Your private notes" while a selection is pending posts with
// its own stored target instead of the selection's.
type OpenDraft = {
  id: string;
  connection?: AnnotationConnectionBundle;
  pdfTarget?: unknown;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  storedQuote?: string;
};

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
    // "Edit" on the draft this slot already has open: nothing to move, and
    // committing "the previous one" would post the very draft being edited.
    if (previous?.id === incoming.id) return;
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
        storedQuote: incoming.storedQuote,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open`/startTransition are read at fire time, not tracked as retrigger deps for this cross-tree signal
  }, [movedDraft, setMovedDraft]);

  const openNew = useCallback(() => {
    setError(null);
    startTransition(async () => {
      // The selection goes onto the row as well as into this slot's state,
      // so the draft keeps it through a reload (createDraftAnnotation).
      const result = await createDraftAnnotation(target, undefined, pdfTarget !== undefined ? { pdfTarget } : undefined);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen({ id: result.id, connection: result.connection, pdfTarget });
    });
  }, [target, pdfTarget]);

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
      <>
        {/* What a reopened draft is anchored to. A draft opened on a fresh
            selection needs no line here: its surface already shows the
            selection. */}
        {open.storedQuote && (
          <p className={styles.quote}>
            Annotating: “{open.storedQuote.length > 80 ? `${open.storedQuote.slice(0, 80)}…` : open.storedQuote}”
          </p>
        )}
        <LiveAnnotationComposer
          // "Move to bottom" swaps a different draft into an open slot, and a
          // new draft is a new composer (LiveAnnotationComposer's header).
          key={open.id}
          annotationId={open.id}
          connection={open.connection}
          anchorFrom={open.anchorFrom}
          anchorTo={open.anchorTo}
          quotedText={open.quotedText}
          pdfTarget={open.pdfTarget}
          container={target.kind}
          onPosted={() => {
            setOpen(null);
            onSettled?.();
            // Narrower than onSettled deliberately: that one also fires on a
            // cancel, whose discard is still in flight here and reloads for
            // itself once it lands (LiveAnnotationComposer). A private save
            // arrives here too, and changes "Your private notes".
            reloadAnnotations();
          }}
          onCancel={() => {
            setOpen(null);
            onSettled?.();
          }}
        />
      </>
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
