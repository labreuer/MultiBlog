"use client";

import { useState, useTransition } from "react";
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
          onPosted={onPosted}
          onCancel={onCancel}
          onMoveToBottom={() => {
            setMovedDraft({ id: draftId, anchorFrom: from, anchorTo: to, quotedText });
            onCancel();
          }}
        />
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
          <button type="button" onClick={handleMoveToBottom} disabled={pending} className={composerStyles.moveToBottom}>
            Move to bottom ⤓
          </button>
          <button type="button" onClick={onCancel} className={composerStyles.cancel}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className={composerStyles.error}>{error}</p>}
    </div>
  );
}
