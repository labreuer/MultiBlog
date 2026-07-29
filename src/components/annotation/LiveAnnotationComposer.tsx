"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import AnnotationBody from "./AnnotationBody";
import { postAnnotation, saveDraftAnnotation, discardDraftAnnotation } from "@/app/actions/annotations";
import styles from "./AnnotationComposer.module.css";

type Props = {
  annotationId: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  onPosted: () => void;
  onCancel: () => void;
  // PLAN.md §13g — present only from the inline popover, absent from the
  // bottom composer and from a reply (neither has anywhere further to
  // move). Clicking it hands the draft's id (and its anchor, if any) to
  // AnnotationMoveProvider and leaves the row untouched — no post, no
  // discard, just a different slot rendering the same connection next.
  onMoveToBottom?: () => void;
};

// PLAN.md §13d — DRAFT/LIVE/RAISED as a single choice rather than two
// independent toggles ("keep private" + "notify authors"): the three
// outcomes are mutually exclusive (there's no such thing as a private
// RAISED annotation), so a select reads the actual state space directly
// instead of letting the UI express a combination that can't exist.
type Visibility = "private" | "post" | "raise";

// PLAN.md §13j Phase 2/4 — the provider-connection lifecycle around
// AnnotationBody, mirroring DocEditor.tsx's own connect-on-mount/
// destroy-on-unmount effect but scoped to one annotation's ydoc rather than
// a doc's. Mounted only once a DRAFT row already exists (createDraftAnnotation,
// called by whichever parent — the bottom composer, a reply, or "Edit" on
// an own saved draft — decided to open one) — this component never creates
// the row itself, only connects to it.
export default function LiveAnnotationComposer({
  annotationId,
  anchorFrom,
  anchorTo,
  quotedText,
  onPosted,
  onCancel,
  onMoveToBottom,
}: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("post");

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [annotationId]);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;

    let firstToken: string | null = null;
    async function fetchToken(): Promise<string> {
      if (firstToken !== null) {
        const t = firstToken;
        firstToken = null;
        return t;
      }
      const res = await fetch(`/api/annotation/${annotationId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate.");
      const { token } = (await res.json()) as { token: string };
      return token;
    }

    (async () => {
      try {
        const res = await fetch(`/api/annotation/${annotationId}/token`, { method: "POST" });
        if (!res.ok) throw new Error("Failed to authenticate.");
        const { token, documentName } = (await res.json()) as { token: string; documentName: string };
        if (cancelled) return;
        firstToken = token;

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: documentName,
          document: ydoc,
          token: fetchToken,
        });
        setProvider(instance);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      ydoc.destroy();
    };
  }, [annotationId, ydoc]);

  // Covers all three outcomes: posted LIVE, posted RAISED, or saved
  // privately (still DRAFT). All three end the same way from the parent's
  // point of view — the composer's job is done, close it — which is why
  // this fires onPosted rather than a fourth "onSavedPrivately" callback;
  // only discardDraftAnnotation (Cancel, below) actually removes the row.
  async function handleSubmit() {
    setPending(true);
    setError(null);
    const result =
      visibility === "private"
        ? await saveDraftAnnotation(annotationId)
        : await postAnnotation({ annotationId, anchorFrom, anchorTo, quotedText, raise: visibility === "raise" });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
    onPosted();
  }

  function handleCancel() {
    onCancel();
    discardDraftAnnotation(annotationId).catch(() => {
      // Best-effort — an orphaned DRAFT is invisible to everyone but its own
      // author (§13d) and harmless, not worth surfacing a failure for.
    });
  }

  if (!provider || !session?.user) {
    return <p className={styles.status}>{error ?? "Connecting…"}</p>;
  }

  const submitLabel = pending
    ? visibility === "private"
      ? "Saving..."
      : "Posting..."
    : visibility === "private"
      ? "Save privately"
      : visibility === "raise"
        ? "Post & notify authors"
        : "Post annotation";

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
      <div className={styles.buttonRow}>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as Visibility)}
          disabled={pending}
          className={styles.visibilitySelect}
          aria-label="Annotation visibility"
        >
          <option value="private">Keep private</option>
          <option value="post">Post</option>
          <option value="raise">Post &amp; notify authors</option>
        </select>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className={`${styles.submit} ${pending ? styles.submitPending : ""}`}
        >
          {submitLabel}
        </button>
        {onMoveToBottom && (
          <button type="button" onClick={onMoveToBottom} className={styles.moveToBottom}>
            Move to bottom ⤓
          </button>
        )}
        <button type="button" onClick={handleCancel} className={styles.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
