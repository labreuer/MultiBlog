"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createDraftAnnotation } from "@/app/actions/annotations";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import { useAnnotationMove } from "./annotation-move-context";
import styles from "./AnnotationPopover.module.css";
import composerStyles from "./AnnotationComposer.module.css";

type Props = {
  docId: string;
  top: number;
  left: number;
  // So the caller can measure this popover's rendered size — placement needs
  // it to clamp/flip (src/lib/popover-placement.ts), and only the caller
  // knows the bounds to clamp into.
  elementRef?: React.Ref<HTMLDivElement>;
  from: number;
  to: number;
  quotedText: string;
  // PLAN.md §12p/§13 — the reading view's own scrub position when known
  // precisely, threaded straight through to LiveAnnotationComposer.
  ydocUpdateId?: string | null;
  // False on the doc editor (PLAN.md §18/COLLAB.md §5) — there is no bottom
  // composer there for a draft to move to.
  allowMoveToBottom?: boolean;
  // Opens straight into the composer instead of showing the "Annotate"
  // button first (PLAN.md §18f). Set by the doc editor, whose collapsed
  // marker already *is* the stage this button would be: the reason the
  // button exists — not spinning up a DRAFT row and a live connection on
  // every micro-adjustment of a selection still being dragged — is already
  // paid for by the marker, and a second click to reach the same composer
  // would be one too many. Never set on the reading views, which have no
  // marker stage of their own.
  autoOpen?: boolean;
  // PLAN.md §18/COLLAB.md §5 — present only from the doc editor's own
  // selection widget, which captured `from`/`to` as Y.RelativePositions
  // rather than trusting the offsets above to still be right by the time
  // the reader clicks Post. Threaded straight through to
  // LiveAnnotationComposer, which is where it actually matters (submit
  // time, not composer-open time).
  resolveAnchor?: () => { from: number; to: number } | null;
  onPosted: () => void;
  onCancel: () => void;
};

// The inline annotation popover (PLAN.md §13j Phase 3). Two stages, not one:
// selecting text alone never creates anything — DocReadingBody's own
// pending-selection decoration (pending-annotation-extension.ts) already
// shows the selection is "about to be annotated" for free, so there's no
// need to also spin up a draft row and a live editor connection on every
// micro-adjustment of a selection someone is still dragging. A row (and its
// ydoc) exists only once "Annotate" — or "Move to bottom", which needs one
// too — is actually clicked.
export default function AnnotationPopover({
  docId,
  top,
  left,
  elementRef,
  from,
  to,
  quotedText,
  ydocUpdateId = null,
  allowMoveToBottom = true,
  autoOpen = false,
  resolveAnchor,
  onPosted,
  onCancel,
}: Props) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { setMovedDraft } = useAnnotationMove();

  function ensureDraft(after: (id: string) => void) {
    setError(null);
    startTransition(async () => {
      const existing = draftId;
      if (existing) {
        after(existing);
        return;
      }
      const result = await createDraftAnnotation(docId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDraftId(result.id);
      after(result.id);
    });
  }

  function handleMoveToBottom() {
    ensureDraft((id) => {
      setMovedDraft({ id, anchorFrom: from, anchorTo: to, quotedText });
      onCancel();
    });
  }

  // Fires once, on mount, for the marker-first surface. A ref rather than a
  // `draftId === null` guard: `ensureDraft` is async inside a transition, so
  // a second effect run before the first resolves would create a second
  // orphan DRAFT row.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    ensureDraft(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by construction; ensureDraft closes over state this deliberately doesn't re-run for
  }, [autoOpen]);

  // `top`/`left` are used exactly as given: the gap below the selection is
  // POPOVER_GAP, applied once by placePopover, not an extra +6 stacked on it
  // here — placement is the caller's job now (src/lib/popover-placement.ts).
  return (
    <div ref={elementRef} data-testid="annotation-popup" className={styles.popover} style={{ top, left }}>
      <p className={styles.quotedText}>
        Annotating: “{quotedText.length > 80 ? `${quotedText.slice(0, 80)}…` : quotedText}”
      </p>
      {draftId ? (
        <LiveAnnotationComposer
          annotationId={draftId}
          anchorFrom={from}
          anchorTo={to}
          quotedText={quotedText}
          ydocUpdateId={ydocUpdateId}
          resolveAnchor={resolveAnchor}
          onPosted={onPosted}
          onCancel={onCancel}
          onMoveToBottom={
            allowMoveToBottom
              ? () => {
                  setMovedDraft({ id: draftId, anchorFrom: from, anchorTo: to, quotedText });
                  onCancel();
                }
              : undefined
          }
        />
      ) : autoOpen ? (
        // The marker was the decision; offering "Annotate" now would be
        // asking for it twice. Only the round trip that creates the row is
        // left to wait out — and Cancel, since it can fail.
        <div className={composerStyles.buttonRow}>
          <p className={composerStyles.status}>Opening…</p>
          <button type="button" onClick={onCancel} className={composerStyles.cancel}>
            Cancel
          </button>
        </div>
      ) : (
        <div className={composerStyles.buttonRow}>
          <button
            type="button"
            onClick={() => ensureDraft(() => {})}
            disabled={pending}
            className={`${composerStyles.submit} ${pending ? composerStyles.submitPending : ""}`}
          >
            {pending ? "Opening…" : "Annotate"}
          </button>
          {allowMoveToBottom && (
            <button type="button" onClick={handleMoveToBottom} disabled={pending} className={composerStyles.moveToBottom}>
              Move to bottom ⤓
            </button>
          )}
          <button type="button" onClick={onCancel} className={composerStyles.cancel}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className={composerStyles.error}>{error}</p>}
    </div>
  );
}
