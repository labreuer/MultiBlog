"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import AnnotationBody from "./AnnotationBody";
import { postAnnotation, discardDraftAnnotation } from "@/app/actions/annotations";
import styles from "./AnnotationComposer.module.css";

type Props = {
  annotationId: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  onPosted: () => void;
  onCancel: () => void;
};

// PLAN.md §13j Phase 2 — the provider-connection lifecycle around
// AnnotationBody, mirroring DocEditor.tsx's own connect-on-mount/
// destroy-on-unmount effect but scoped to one annotation's ydoc rather than
// a doc's. Mounted only once a DRAFT row already exists (createDraftAnnotation,
// called by whichever parent — the bottom composer or a reply — decided to
// open one) — this component never creates the row itself, only connects to it.
export default function LiveAnnotationComposer({ annotationId, anchorFrom, anchorTo, quotedText, onPosted, onCancel }: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handlePost() {
    setPending(true);
    setError(null);
    const result = await postAnnotation({ annotationId, anchorFrom, anchorTo, quotedText });
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
        <button
          type="button"
          onClick={handlePost}
          disabled={pending}
          className={`${styles.submit} ${pending ? styles.submitPending : ""}`}
        >
          {pending ? "Posting..." : "Post annotation"}
        </button>
        <button type="button" onClick={handleCancel} className={styles.cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
