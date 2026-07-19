"use client";

import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { renderToReactElement } from "@tiptap/static-renderer";
import { authorHighlightExtensions, collectMarkAttrValues } from "@/lib/tiptap-schema";
import { useAuthorColors } from "@/lib/use-author-colors";
import AuthorHighlightStyles from "./AuthorHighlightStyles";
import proseStyles from "@/styles/prose.module.css";

type LogEntry = { ts: number; bytes: Uint8Array };

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

export default function LiveHistoryViewer({ postId }: { postId: string }) {
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [position, setPosition] = useState(0);
  const [live, setLive] = useState(true);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let provider: HocuspocusProvider | null = null;
    const liveTapDoc = new Y.Doc();

    (async () => {
      try {
        const [tokenRes, logRes] = await Promise.all([
          fetch("/api/collab-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ postId }),
          }),
          fetch(`/api/posts/${postId}/collab-updates`),
        ]);
        if (!tokenRes.ok) throw new Error("Failed to authenticate for live history.");
        if (!logRes.ok) throw new Error("Failed to load edit history.");

        const { token } = await tokenRes.json();
        const { updates } = (await logRes.json()) as { updates: { ts: number; update: string }[] };
        if (cancelled) return;

        const initial = updates.map((u) => ({ ts: u.ts, bytes: base64ToBytes(u.update) }));
        setLog(initial);
        setPosition(Math.max(0, initial.length - 1));

        provider = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: postId,
          document: liveTapDoc,
          token,
          onStatus: ({ status: s }) => setStatus(s),
          onAuthenticationFailed: ({ reason }) => setError(`Live updates unavailable: ${reason}`),
          onSynced: () => {
            // Only start tailing *after* the initial handshake — that handshake's
            // own "update" already reflects everything the REST fetch above just
            // gave us, so counting it too would just double an already-applied step.
            liveTapDoc.on("update", (update: Uint8Array) => {
              setLog((prev) => [...(prev ?? []), { ts: Date.now(), bytes: update }]);
            });
          },
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      provider?.destroy();
      liveTapDoc.destroy();
    };
  }, [postId]);

  const total = log?.length ?? null;
  const effectivePosition = live && total !== null ? total - 1 : position;

  const replayed = useMemo(() => {
    if (!log || log.length === 0) {
      return null;
    }
    const scratch = new Y.Doc();
    for (const entry of log.slice(0, effectivePosition + 1)) {
      Y.applyUpdate(scratch, entry.bytes);
    }
    const json = TiptapTransformer.extensions(authorHighlightExtensions).fromYdoc(scratch, "default");
    scratch.destroy();
    return json;
  }, [log, effectivePosition]);

  const authorIds = useMemo(
    () => (replayed ? collectMarkAttrValues(replayed, "authorHighlight", "authorId") : []),
    [replayed],
  );
  const authorColors = useAuthorColors(authorIds);

  const content = useMemo(() => {
    if (!replayed) return null;
    try {
      return renderToReactElement({ content: replayed, extensions: authorHighlightExtensions });
    } catch {
      return null;
    }
  }, [replayed]);

  const currentTs = log && log.length > 0 ? log[effectivePosition]?.ts : null;

  return (
    <div>
      <p style={{ fontSize: "0.85rem", color: "#666" }}>
        {status === "connected" ? "🟢 Live" : status === "connecting" ? "🟡 Connecting…" : "🔴 Disconnected"}
        {error && ` — ${error}`}
      </p>

      {total === null ? (
        <p>Loading history…</p>
      ) : total === 0 ? (
        <p>No edits since the last saved revision yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "12px 0" }}>
            <input
              type="range"
              min={0}
              max={Math.max(0, total - 1)}
              value={effectivePosition}
              onChange={(e) => {
                const value = Number(e.target.value);
                setPosition(value);
                setLive(value >= total - 1);
              }}
              style={{ flex: 1 }}
              aria-label="Scrub through edit history"
            />
            <button type="button" onClick={() => setLive(true)} disabled={live}>
              Jump to live
            </button>
          </div>
          <p style={{ fontSize: "0.8rem", color: "#666" }}>
            {live ? "Live — " : ""}
            edit {effectivePosition + 1} of {total}
            {currentTs ? ` — ${new Date(currentTs).toLocaleString()}` : ""}
          </p>
          <AuthorHighlightStyles colors={authorColors} />
          <div className={proseStyles.prose} style={{ border: "1px solid #ddd", borderRadius: 4, padding: "1rem" }}>
            {content ?? <p style={{ color: "#999" }}>Nothing to show yet.</p>}
          </div>
        </>
      )}
    </div>
  );
}
