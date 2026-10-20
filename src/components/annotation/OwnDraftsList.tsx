"use client";

import { useAnnotationMove } from "./annotation-move-context";
import type { OwnDraft } from "@/lib/annotation-data";
import styles from "./OwnDraftsList.module.css";

// PLAN.md §13d — the only place a "Keep private" draft is reachable again,
// and a draft whose composer a reload took away: getDocAnnotationsAsThreads
// and getFileAnnotationsAsThreads exclude every DRAFT unconditionally, so
// without this list such a draft would be functionally unreachable the
// moment its composer closed. Rendered under the bottom composer on
// /doc/[slug] and under the panel's composer on /pdf/[slug]. "Edit" reuses
// the exact mechanism "Move to bottom" already established
// (AnnotationMoveProvider) — handing NewAnnotationComposer's slot an
// existing draft id rather than having it call createDraftAnnotation for a
// new one. It hands over no anchor: the row has its own (MovedDraft).
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
            <span className={styles.text}>
              <span className={styles.preview}>
                {draft.isReply && <span className={styles.kind}>Reply: </span>}
                {draft.bodyText.trim() || "(empty)"}
              </span>
              {draft.quotedText && <span className={styles.quote}>on “{draft.quotedText}”</span>}
            </span>
            <button
              type="button"
              onClick={() => setMovedDraft({ id: draft.id, storedQuote: draft.quotedText || undefined })}
              className={styles.editButton}
            >
              Edit
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
