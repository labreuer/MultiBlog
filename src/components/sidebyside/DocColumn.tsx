"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { JSONContent } from "@tiptap/react";
import type { ReactNode } from "react";
import { attachIndexeddb } from "@/lib/ydoc-persistence";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import LiveDocBody from "@/components/LiveDocBody";
import CollabTitleField from "@/components/CollabTitleField";
import CollabEditorBody from "@/components/CollabEditorBody";
import proseStyles from "@/styles/prose.module.css";
import styles from "./DocColumn.module.css";

type Props = {
  docId: string;
  initialTitle: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
  side: "left" | "right";
  userId: string;
  userName: string;
  userColor: string;
};

const ARIA = {
  left: { body: "Left doc body", title: "Left doc title" },
  right: { body: "Right doc body", title: "Right doc title" },
} as const;

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type Mode = "read" | "write";

// PLAN.md §14g — one Y.Doc and one provider per column, reused across both
// read and write modes: the read surface needs a Y.Doc plus a provider and
// taps ydoc.on("update"); the write surface needs the same Y.Doc bound
// through Collaboration/CollaborationCaret on the same provider. Toggling
// mode therefore unmounts/mounts only the TipTap editors underneath, never
// the websocket — putting the provider inside LiveDocBody instead (as
// /doc/[slug] does) would tear down a socket and re-mint a token on every
// toggle.
export default function DocColumn({ docId, initialTitle, initialBodyJSON, staticBody, side, userId, userName, userColor }: Props) {
  const [mode, setMode] = useState<Mode>("read");
  const [title, setTitle] = useState(initialTitle);
  // null until the token response arrives — distinct from false, since
  // "may this viewer write" gates whether the Edit button renders at all.
  const [readOnly, setReadOnly] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [lineage, setLineage] = useState<{ documentName: string; lineageMs: number } | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [docId]);

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
      const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate.");
      const { token } = (await res.json()) as { token: string };
      return token;
    }

    (async () => {
      const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
      if (!res.ok || cancelled) return;
      const { token, lineage: lineageMs, documentName, readOnly: tokenReadOnly } = (await res.json()) as {
        token: string;
        lineage: number;
        documentName: string;
        readOnly: boolean;
      };
      if (cancelled) return;
      firstToken = token;
      setReadOnly(tokenReadOnly);
      setLineage({ documentName, lineageMs });

      instance = new HocuspocusProvider({
        url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
        name: documentName,
        document: ydoc,
        token: fetchToken,
        onStatus: ({ status }) => setConnectionStatus(status),
      });
      setProvider(instance);
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      ydoc.destroy();
    };
  }, [docId, ydoc]);

  // attachIndexeddb runs only for a column actually in write mode (§14g) —
  // detached again the moment it toggles back to read, or on unmount.
  useEffect(() => {
    if (mode !== "write" || !lineage) return;
    const detach = attachIndexeddb(ydoc, lineage.documentName, lineage.lineageMs);
    return detach;
  }, [mode, lineage, ydoc]);

  const canEdit = readOnly === false;
  const aria = ARIA[side];

  return (
    <DocPresenceProvider>
      <div className={styles.column} data-side={side}>
        <div className={styles.titleRow}>
          {mode === "write" && provider ? (
            <>
              <CollabTitleField
                ydoc={ydoc}
                userId={userId}
                userName={userName}
                userColor={userColor}
                className={styles.titleInput}
                ariaLabel={aria.title}
                onTitleChange={setTitle}
                onEditorReady={() => {}}
              />
              {/* PLAN.md §14g — "Doc Links" switches this column back to
                  read mode, which is where a doc link is created (§14i);
                  it is not a panel opener. */}
              <button type="button" className={styles.titleButton} onClick={() => setMode("read")}>
                Doc Links
              </button>
            </>
          ) : (
            <>
              <h2 className={styles.titleText}>
                <Link href={canEdit ? `/doc/${docId}/edit` : `/doc/${docId}`}>{title}</Link>
              </h2>
              {canEdit && (
                <button type="button" className={styles.titleButton} onClick={() => setMode("write")}>
                  Edit
                </button>
              )}
            </>
          )}
        </div>
        {mode === "write" && (
          <p className={styles.statusLine}>
            {connectionStatus === "connected" ? "🟢 Live" : connectionStatus === "connecting" ? "🟡 Connecting…" : "🔴 Disconnected"}
          </p>
        )}
        <div className={styles.scroller}>
          {mode === "write" ? (
            provider ? (
              <CollabEditorBody
                provider={provider}
                ydoc={ydoc}
                userId={userId}
                userName={userName}
                userColor={userColor}
                onEditorReady={() => {}}
                ariaLabel={aria.body}
                suppressAnnotations
              />
            ) : (
              <p>Connecting to live editor…</p>
            )
          ) : provider ? (
            <LiveDocBody
              docId={docId}
              initialBodyJSON={initialBodyJSON}
              staticBody={staticBody}
              userColor={userColor}
              ariaLabel={aria.body}
              selectionUi="none"
              suppressAnnotations
              ydoc={ydoc}
              provider={provider}
            />
          ) : (
            // Mirrors LiveDocBody's own pre-connection fallback — shown
            // until this column's provider connects, rather than mounting
            // LiveDocBody without one (which would make it open its own,
            // separate, immediately-redundant connection — §14g).
            <div className={`${proseStyles.prose} ${proseStyles.noAnnotations}`}>{staticBody}</div>
          )}
        </div>
      </div>
    </DocPresenceProvider>
  );
}
