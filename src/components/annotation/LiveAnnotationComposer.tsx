"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import AnnotationBody from "./AnnotationBody";
import { getCollabUrl } from "@/lib/collab-url";
import { useDocPresence } from "./doc-presence-context";
import { postAnnotation, saveDraftAnnotation, discardDraftAnnotation } from "@/app/actions/annotations";
import styles from "./AnnotationComposer.module.css";

type Props = {
  annotationId: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  // PLAN.md §13o — which anchoring mechanism this composer's surface uses.
  // Defaults to "columns" (either reading view); only the doc editor's own
  // popover passes "mark", because only it already holds a writable
  // connection to the document the mark would be written into.
  anchorMode?: "mark" | "columns";
  // PLAN.md §13q — passed to postAnnotation, which converts it to a
  // ydoc_update.id. Absent from any surface with no live Y.Doc to capture
  // from, in which case the action falls back to the log tail.
  atVersion?: string | null;
  // PLAN.md §12p/§13 — passed straight to postAnnotation; absent from every
  // caller but the inline popover on a scrub-frozen reading view, which is
  // the only one that ever knows a position more precise than "just now".
  ydocUpdateId?: string | null;
  // PLAN.md §18/COLLAB.md §5 — present only from the doc editor's own
  // selection widget. When set, this is authoritative over anchorFrom/
  // anchorTo at submit time: those two are what the selection was when
  // composing *started*, exactly the stale value Phase 3 exists to stop
  // trusting. A null result (the anchored text is gone) posts document-level
  // rather than falling back to the stale offsets.
  resolveAnchor?: () => { from: number; to: number } | null;
  // PLAN.md §19 — a PDF anchor (docs/PDF.md §2's Target), present only from the
  // /pdf/[slug] composer. Passed straight through to postAnnotation, which
  // validates it and derives `quotedText` from its own stored page text rather
  // than believing anything in here.
  pdfTarget?: unknown;
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
  anchorMode = "columns",
  atVersion = null,
  ydocUpdateId,
  resolveAnchor,
  pdfTarget,
  onPosted,
  onCancel,
  onMoveToBottom,
}: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  const { awareness } = useDocPresence();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("post");

  const userId = session?.user?.id;
  const userDisplayName = session?.user?.name ?? session?.user?.email ?? "Someone";
  const userColor = session?.user?.color;

  // PLAN.md §13i — publishes "someone is writing an annotation" onto the
  // doc's own awareness (not this annotation's — that one is only visible
  // to whoever's already connected to it) whenever this composer is open
  // and not set to Keep private. The cleanup covers every way that stops
  // being true: switching to private, posting, cancelling, or unmounting —
  // all of them re-run or tear down this effect, which is what always
  // clears the field rather than needing a separate branch for each.
  useEffect(() => {
    if (!awareness || !userId || visibility === "private") return;
    awareness.setLocalStateField("annotationEditing", { annotationId, name: userDisplayName, color: userColor });
    return () => {
      awareness.setLocalStateField("annotationEditing", null);
    };
  }, [awareness, userId, userDisplayName, userColor, visibility, annotationId]);

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
          url: getCollabUrl(),
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
    // resolveAnchor, when present, is authoritative — see its own prop
    // comment. `resolved` undefined (no resolveAnchor at all) falls back to
    // the literal props; `resolved` null (resolveAnchor ran and found
    // nothing) posts document-level rather than reusing the stale literals.
    const resolved = resolveAnchor?.();
    const finalAnchorFrom = resolveAnchor ? resolved?.from : anchorFrom;
    const finalAnchorTo = resolveAnchor ? resolved?.to : anchorTo;
    const result =
      visibility === "private"
        ? await saveDraftAnnotation(annotationId)
        : await postAnnotation({
            annotationId,
            anchorMode,
            atVersion: atVersion ?? undefined,
            anchorFrom: finalAnchorFrom,
            anchorTo: finalAnchorTo,
            quotedText,
            raise: visibility === "raise",
            ydocUpdateId: ydocUpdateId ?? undefined,
            pdfTarget,
          });
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
