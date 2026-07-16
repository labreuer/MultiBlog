"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Editor } from "@tiptap/react";
import { saveDraft, publishPost } from "@/app/actions/posts";
import CollabEditorBody from "./CollabEditorBody";
import styles from "./PostEditor.module.css";

type Props = {
  postId: string;
  initialTitle: string;
  revisionNumber: number;
  userName: string;
};

type ConnectionStatus = "connecting" | "connected" | "disconnected";

export default function PostEditor({ postId, initialTitle, revisionNumber, userName }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);

  // Recreate the Y.Doc if postId ever changes under the same mounted instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [postId]);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;

    (async () => {
      try {
        const res = await fetch("/api/collab-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId }),
        });
        if (!res.ok) {
          throw new Error("Failed to authenticate for live editing.");
        }
        const { token } = await res.json();
        if (cancelled) return;

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: postId,
          document: ydoc,
          token,
          onStatus: ({ status: s }) => setConnectionStatus(s),
          onAuthenticationFailed: ({ reason }) => setError(`Live editing unavailable: ${reason}`),
          onAwarenessUpdate: ({ states }) => {
            const names = states
              .map((s) => (s.user as { name?: string } | undefined)?.name)
              .filter((n): n is string => typeof n === "string" && n !== userName);
            setPeers(Array.from(new Set(names)));
          },
        });
        setProvider(instance);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [postId, ydoc, userName]);

  const handleSaveDraft = () => {
    if (!editor) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = editor.getJSON();
        const result = await saveDraft(postId, title, doc);
        setStatus(`Saved as revision #${result.revisionNumber}`);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save.");
      }
    });
  };

  const handlePublish = () => {
    if (!editor) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = editor.getJSON();
        const result = await publishPost(postId, title, doc, changelog);
        setStatus(`Published as revision #${result.revisionNumber}`);
        setChangelog("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to publish.");
      }
    });
  };

  return (
    <div className={styles.container}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Title"
        className={styles.titleInput}
      />
      <p className={styles.statusLine}>
        {connectionStatus === "connected" ? "🟢 Live" : connectionStatus === "connecting" ? "🟡 Connecting…" : "🔴 Disconnected"}
        {peers.length > 0 && ` — editing with ${peers.join(", ")}`}
      </p>
      {provider ? (
        <CollabEditorBody provider={provider} ydoc={ydoc} userName={userName} onEditorReady={setEditor} />
      ) : (
        <p>Connecting to live editor…</p>
      )}
      <div className={styles.actionsRow}>
        <button type="button" onClick={handleSaveDraft} disabled={pending || !editor}>
          Save draft
        </button>
        <input
          placeholder="Changelog (optional)"
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          className={styles.changelogInput}
        />
        <button type="button" onClick={handlePublish} disabled={pending || !editor}>
          Publish
        </button>
      </div>
      {status && <p className={styles.statusMessage}>{status}</p>}
      {error && <p className={styles.errorMessage}>{error}</p>}
      <p className={styles.revisionNote}>Currently viewing revision #{revisionNumber}.</p>
    </div>
  );
}
