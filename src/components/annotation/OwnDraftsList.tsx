"use client";

import { useAnnotationMove } from "./annotation-move-context";
import type { OwnDraft } from "@/lib/annotation-data";
import styles from "./OwnDraftsList.module.css";

// PLAN.md §13d — the only place a "Keep private" draft is reachable again:
// getDocAnnotationsAsThreads excludes every DRAFT unconditionally, so
// without this list a saved-private annotation would be functionally
// unreachable the moment its composer closed. "Edit" reuses the exact
// mechanism "Move to bottom" already established (AnnotationMoveProvider) —
// handing NewAnnotationComposer's slot an existing draft id rather than
// having it call createDraftAnnotation for a new one.
export default function OwnDraftsList({ drafts }: { drafts: OwnDraft[] }) {
  const { setMovedDraft } = useAnnotationMove();

  if (drafts.length === 0) {
    return null;
  }

  return (
    <div className={styles.wrapper}>
      <p className={styles.heading}>Your private notes</p>
      <ul className={styles.list}>
        {drafts.map((draft) => (
          <li key={draft.id} className={styles.item}>
            <span className={styles.preview}>{draft.bodyText.trim() || "(empty)"}</span>
            <button type="button" onClick={() => setMovedDraft({ id: draft.id })} className={styles.editButton}>
              Edit
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
