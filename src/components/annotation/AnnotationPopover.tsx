"use client";

import AnnotationComposer from "./AnnotationComposer";
import styles from "./AnnotationPopover.module.css";

type Props = {
  docId: string;
  top: number;
  left: number;
  from: number;
  to: number;
  quotedText: string;
  onPosted: () => void;
  onCancel: () => void;
};

// The inline annotation popover (PLAN.md §13c) — extracted out of
// LiveDocBody.tsx's own JSX so it can grow the pending-selection decoration
// and the "Move to bottom" control (§13f/§13g) without bloating the reading
// view's already-large effect-heavy component. top/left carry forward
// unchanged from LiveDocBody's own `coords.bottom - containerRect.top` /
// `coords.left - containerRect.left` computation — the +0.5em/+0.5em nudge
// (PLAN.md §13k) is a separate, later pass over this same component.
export default function AnnotationPopover({ docId, top, left, from, to, quotedText, onPosted, onCancel }: Props) {
  return (
    <div data-testid="annotation-popup" className={styles.popover} style={{ top: top + 6, left }}>
      <p className={styles.quotedText}>
        Annotating: “{quotedText.length > 80 ? `${quotedText.slice(0, 80)}…` : quotedText}”
      </p>
      <AnnotationComposer
        docId={docId}
        anchorFrom={from}
        anchorTo={to}
        quotedText={quotedText}
        onPosted={onPosted}
        onCancel={onCancel}
      />
    </div>
  );
}
