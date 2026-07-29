"use client";

import { useState, useTransition } from "react";
import { createDraftAnnotation } from "@/app/actions/annotations";
import LiveAnnotationComposer from "./LiveAnnotationComposer";
import styles from "./AnnotationComposer.module.css";

type Props = { docId: string };

// The bottom-of-page composer's open/closed wrapper (PLAN.md §13j Phase 2) —
// AnnotationSection is a server component and can't hold the "have I
// created my draft yet" state itself, so this is the client boundary.
// Collapsed by default (a placeholder trigger, not a live editor sitting
// open on every page load): opening it creates a DRAFT eagerly, same
// reasoning §13d gives for why a composer needs a row before a single
// keystroke lands.
export default function NewAnnotationComposer({ docId }: Props) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open() {
    setError(null);
    startTransition(async () => {
      const result = await createDraftAnnotation(docId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDraftId(result.id);
    });
  }

  if (draftId) {
    return (
      <LiveAnnotationComposer
        annotationId={draftId}
        onPosted={() => setDraftId(null)}
        onCancel={() => setDraftId(null)}
      />
    );
  }

  return (
    <div>
      <button type="button" onClick={open} disabled={pending} className={`${styles.field} ${styles.placeholder}`}>
        {pending ? "Opening…" : "Write an annotation..."}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
