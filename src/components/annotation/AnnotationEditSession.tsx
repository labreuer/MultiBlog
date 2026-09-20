"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import AnnotationBody from "./AnnotationBody";
import { useAnnotationProvider } from "./use-annotation-provider";
import { cancelAnnotationEdit, finishAnnotationEdit } from "@/app/actions/annotations";
import type { AnnotationConnectionBundle } from "@/lib/annotation-connection";
import styles from "./AnnotationNode.module.css";

type Props = {
  annotationId: string;
  // The bundle `beginAnnotationEdit` handed back (annotation-connection.ts).
  // It matters most here: this card is swapping a rendered body for an
  // editor, so a wait before the connection is a visibly emptier card than
  // the one that was just there.
  connection?: AnnotationConnectionBundle;
  /** The session ended with a revision (or with nothing changed). */
  onFinished: () => void;
  /** The session ended with the previous version put back. */
  onCancelled: () => void;
};

// PLAN.md §22e — a live editor on an already-posted annotation body, which
// until now only a DRAFT composer ever had.
//
// Structurally the composer minus everything about *posting*: no visibility
// select, no anchor to capture, no mark to apply. What it shares is the
// connection lifecycle, which is why that moved into `useAnnotationProvider`
// rather than being copied.
//
// **Nobody else sees these keystrokes**, and that is deliberate. While the
// session is open `Annotation.editingSince` is set, which stops the store
// debounce from writing the cache every reader renders from — so a reader on
// the same doc keeps seeing the last settled body until Done. That is what
// let mutable bodies arrive without a live editor per card (docs/COLLAB.md's
// 2026-08-13 entry weighed the alternative, awareness-driven mounting; it
// stays available and is not needed for this).
export default function AnnotationEditSession({ annotationId, connection, onFinished, onCancelled }: Props) {
  const { data: session } = useSession();
  const { provider, ydoc, readOnly, error: connectionError } = useAnnotationProvider(annotationId, connection);
  const [pending, setPending] = useState<null | "finish" | "cancel">(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFinish() {
    setPending("finish");
    setError(null);
    const result = await finishAnnotationEdit(annotationId);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onFinished();
  }

  async function handleCancel() {
    setPending("cancel");
    setError(null);
    const result = await cancelAnnotationEdit(annotationId);
    setPending(null);
    if (result.error) {
      // The session stays open on failure — see replaceAnnotationBody's own
      // comment. Telling the author it rolled back while their abandoned text
      // is still the live body would be a lie they cannot check.
      setError(result.error);
      return;
    }
    onCancelled();
  }

  if (!provider || !session?.user) {
    return <p className={styles.editStatus}>{connectionError ?? "Connecting…"}</p>;
  }

  // Belt and braces, and cheap: the server already refuses to open a session
  // for anyone who fails the same gate, and the token this connection holds
  // is read-only for them regardless (PR 1). If both of those somehow let
  // someone through, an editor they cannot type into is the honest result.
  if (readOnly === true) {
    return <p className={styles.editStatus}>You don&apos;t have permission to edit this annotation.</p>;
  }

  return (
    <div>
      <AnnotationBody
        provider={provider}
        ydoc={ydoc}
        userId={session.user.id}
        userName={session.user.name ?? session.user.email ?? "Anonymous"}
        userColor={session.user.color}
        editable
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.editActions}>
        <button type="button" onClick={handleFinish} disabled={pending !== null} className={styles.confirmYes}>
          {pending === "finish" ? "Saving…" : "Done"}
        </button>{" "}
        /{" "}
        <button type="button" onClick={handleCancel} disabled={pending !== null} className={styles.confirmNo}>
          {pending === "cancel" ? "Restoring…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
