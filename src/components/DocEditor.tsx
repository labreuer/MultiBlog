"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { attachIndexeddb } from "@/lib/ydoc-persistence";
import { UNTITLED_DOC } from "@/lib/doc-title";
import CollabEditorBody, { type AuthorStat } from "./CollabEditorBody";
import CollabTitleField from "./CollabTitleField";
import DocSettingsPanel, { type EligibleUser } from "./DocSettingsPanel";
import type { DocVisibility } from "@/generated/prisma/enums";
import styles from "./DocEditor.module.css";

type Props = {
  docId: string;
  slug: string;
  initialTitle: string;
  visibility: DocVisibility;
  createdAt: Date;
  userId: string;
  userName: string;
  userColor: string;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  initialDeleted: boolean;
};

type ConnectionStatus = "connecting" | "connected" | "disconnected";

// A much smaller sibling of PostEditor (PLAN.md §12k): no save/publish/
// schedule (a doc has no revisions — it auto-persists through the collab
// server itself, PLAN.md §12d), no revision diff, no title autosave — the
// title is a cache doc-cache.ts writes server-side from the "title"
// fragment, not something this component pushes. What's left is close to
// /ydoc-debug's editing mode (YdocDebug.tsx's EditView): provider wiring,
// attachIndexeddb for offline durability, CollabTitleField/CollabEditorBody
// reused unmodified, plus DocSettingsPanel for byline and visibility.
export default function DocEditor({
  docId,
  slug,
  initialTitle,
  visibility,
  createdAt,
  userId,
  userName,
  userColor,
  authorIds,
  eligibleUsers,
  initialDeleted,
}: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [deleted, setDeleted] = useState(initialDeleted);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [authorStats, setAuthorStats] = useState<AuthorStat[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [docId]);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;
    let detachIndexeddb: (() => void) | null = null;

    // Same reconnect fix as PostEditor.tsx: `token` as a function is called
    // on every connection attempt, not just the first, so a long-idle tab's
    // reconnect gets a freshly-minted token instead of retrying the
    // original 2-minute-expired one forever. The first call reuses the
    // token already fetched below (lineage has to come from that same
    // response before the provider is even constructed — see the
    // attachIndexeddb call); only a later call hits the network again.
    let firstToken: string | null = null;
    async function fetchToken(): Promise<string> {
      if (firstToken !== null) {
        const t = firstToken;
        firstToken = null;
        return t;
      }
      const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate for live editing.");
      const { token } = (await res.json()) as { token: string };
      return token;
    }

    (async () => {
      try {
        const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
        if (!res.ok) {
          throw new Error("Failed to authenticate for live editing.");
        }
        const { token, lineage, documentName } = (await res.json()) as {
          token: string;
          lineage: number;
          documentName: string;
        };
        if (cancelled) return;
        firstToken = token;

        // Lineage has to be known before connecting — see PLAN.md §11e for why
        // attaching first (or caching the lineage) would let a stale local
        // copy merge into a re-seeded document.
        detachIndexeddb = attachIndexeddb(ydoc, documentName, lineage);

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: documentName,
          document: ydoc,
          token: fetchToken,
          onStatus: ({ status }) => setConnectionStatus(status),
          onAuthenticationFailed: ({ reason }) => setError(`Live editing unavailable: ${reason}`),
        });
        setProvider(instance);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      detachIndexeddb?.();
      ydoc.destroy();
    };
  }, [docId, ydoc]);

  return (
    <div className={styles.container}>
      {provider ? (
        <CollabTitleField
          ydoc={ydoc}
          userId={userId}
          userName={userName}
          userColor={userColor}
          editable={!deleted}
          className={`${styles.titleInput} ${deleted ? styles.titleInputDisabled : ""}`}
          placeholder={UNTITLED_DOC}
          onTitleChange={setTitle}
          onEditorReady={() => {}}
        />
      ) : (
        // Same fallback text/color as the placeholder above, so the swap
        // from this pre-connection div to the live editor doesn't flip an
        // untitled doc's title between two different grays.
        <div className={`${styles.titleInput} ${styles.titleInputDisabled}`}>
          {title || <span style={{ color: "#999" }}>{UNTITLED_DOC}</span>}
        </div>
      )}
      <p className={styles.statusLine}>
        {connectionStatus === "connected" ? "🟢 Live" : connectionStatus === "connecting" ? "🟡 Connecting…" : "🔴 Disconnected"}
        {authorStats.length > 0 && " ("}
        {authorStats.map((author, i) => (
          <span key={author.authorId}>
            {i > 0 && ", "}
            <span style={{ color: author.color }}>{author.name}</span>
          </span>
        ))}
        {authorStats.length > 0 && ")"}
      </p>
      {provider ? (
        <CollabEditorBody
          provider={provider}
          ydoc={ydoc}
          userId={userId}
          userName={userName}
          userColor={userColor}
          editable={!deleted}
          onEditorReady={() => {}}
          onAuthorStats={setAuthorStats}
        />
      ) : (
        <p>Connecting to live editor…</p>
      )}
      {error && <p className={styles.errorMessage}>{error}</p>}
      <p className={styles.docNote}>
        Docs save themselves as you type — there&apos;s no draft to publish.{" "}
        <Link href={`/doc/${slug}`}>View</Link> · <Link href={`/doc/${slug}/live-history`}>Scrub live history</Link>
      </p>
      <DocSettingsPanel
        docId={docId}
        visibility={visibility}
        createdAt={createdAt}
        authorIds={authorIds}
        eligibleUsers={eligibleUsers}
        deleted={deleted}
        onDeletedChange={setDeleted}
      />
    </div>
  );
}
