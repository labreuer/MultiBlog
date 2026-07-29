"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { renderYdocBlob, type YdocRenderResult } from "@/lib/ydoc-render";
import { attachIndexeddb } from "@/lib/ydoc-persistence";
import CollabEditorBody from "./CollabEditorBody";
import CollabTitleField from "./CollabTitleField";
import adminStyles from "./AdminTable.module.css";
import proseStyles from "@/styles/prose.module.css";
import styles from "./YdocDebug.module.css";

// Client half of /ydoc-debug (PLAN.md §11f) — a proving ground for the
// standalone ydoc persistence stack, entirely separate from post editing.
// Reuses CollabEditorBody/CollabTitleField unmodified for the editing half;
// everything else here is new.

type DocSummary = { id: string; createdAt: string; updatedAt: string };
type UpdateRow = { id: string; createdAt: string; byteLength: number };
type SnapshotRow = { id: string; createdAt: string; lastYdocUpdateId: string; userId: string | null; byteLength: number };
type DocDetail = {
  ydoc: { id: string; createdAt: string; updatedAt: string; ydocBase64: string; byteLength: number; stateVectorLength: number };
  updateCount: number;
  lastUpdates: UpdateRow[];
  snapshots: SnapshotRow[];
};

type Props = {
  initialDocs: DocSummary[];
  userId: string;
  userName: string;
  userColor: string;
};

type Mode = "read" | "edit";
type ConnectionStatus = "connecting" | "connected" | "disconnected";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export default function YdocDebug({ initialDocs, userId, userName, userColor }: Props) {
  const [docs, setDocs] = useState<DocSummary[]>(initialDocs);
  const [selectedId, setSelectedId] = useState<string | null>(initialDocs[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    const res = await fetch("/api/ydoc");
    if (!res.ok) return;
    const { ydocs } = (await res.json()) as { ydocs: DocSummary[] };
    setDocs(ydocs);
  }, []);

  const handleNewDocument = () => {
    setCreating(true);
    (async () => {
      try {
        const res = await fetch("/api/ydoc", { method: "POST" });
        if (!res.ok) throw new Error(`Failed to create document (${res.status}).`);
        const { id } = (await res.json()) as { id: string };
        await fetchDocs();
        setCreateError(null);
        setSelectedId(id);
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : "Failed to create document.");
      } finally {
        setCreating(false);
      }
    })();
  };

  return (
    <main className={styles.container}>
      <h1>Ydoc debug</h1>
      <p className={styles.intro}>
        Standalone proving ground for the ydoc persistence stack (PLAN.md §11) — separate
        tables, separate Hocuspocus hooks. Nothing here is read or written by post editing.
      </p>

      <div className={styles.controlsRow}>
        <label htmlFor="ydoc-select">Document</label>
        <select id="ydoc-select" value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value || null)}>
          {docs.length === 0 && <option value="">No documents yet</option>}
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.id} — updated {new Date(doc.updatedAt).toLocaleString()}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleNewDocument} disabled={creating}>
          New document
        </button>
      </div>

      {createError && <p className={styles.error}>{createError}</p>}

      {/* Keyed by document id so switching the selection remounts this panel
          entirely — its mode/detail/render state is naturally fresh for the
          newly selected document instead of needing an effect to reset it. */}
      {selectedId && (
        <DocumentPanel key={selectedId} documentId={selectedId} userId={userId} userName={userName} userColor={userColor} />
      )}
    </main>
  );
}

function DocumentPanel({
  documentId,
  userId,
  userName,
  userColor,
}: {
  documentId: string;
  userId: string;
  userName: string;
  userColor: string;
}) {
  const [mode, setMode] = useState<Mode>("read");
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<YdocRenderResult | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  const fetchDetail = useCallback(async (): Promise<DocDetail | null> => {
    const res = await fetch(`/api/ydoc/${documentId}`);
    if (!res.ok) {
      setDetailError(`Failed to load document (${res.status}).`);
      setDetail(null);
      return null;
    }
    const data = (await res.json()) as DocDetail;
    setDetailError(null);
    setDetail(data);
    return data;
  }, [documentId]);

  // Re-fetches the detail payload and, in read mode, re-decodes the blob —
  // shared by the initial load, the Refresh button, and the post-snapshot
  // follow-up so the new snapshot row appears without a second click.
  const refresh = useCallback(async () => {
    const data = await fetchDetail();
    if (data && mode === "read") {
      setRenderResult(renderYdocBlob(base64ToBytes(data.ydoc.ydocBase64)));
    }
  }, [mode, fetchDetail]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchDetail();
      if (!cancelled && data && mode === "read") {
        setRenderResult(renderYdocBlob(base64ToBytes(data.ydoc.ydocBase64)));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only on mount for this documentId — refresh() (used by the Refresh and
    // Snapshot buttons) covers every later re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSnapshot = () => {
    setSnapshotting(true);
    (async () => {
      try {
        const res = await fetch(`/api/ydoc/${documentId}/snapshot`, { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Snapshot failed (${res.status}).`);
        }
        await refresh();
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : "Snapshot failed.");
      } finally {
        setSnapshotting(false);
      }
    })();
  };

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeadRow}>
          <h2>{mode === "read" ? "Read-only view" : "Editing"}</h2>
          {mode === "read" ? (
            <button type="button" onClick={() => setMode("edit")}>
              Switch to editing
            </button>
          ) : (
            <button type="button" onClick={() => setMode("read")}>
              Switch to read-only
            </button>
          )}
        </div>

        {mode === "read" ? (
          <ReadOnlyView renderResult={renderResult} />
        ) : (
          <EditView documentName={documentId} userId={userId} userName={userName} userColor={userColor} />
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeadRow}>
          <h2>Refresh</h2>
          <div className={styles.buttonGroup}>
            <button type="button" onClick={refresh}>
              Refresh
            </button>
            <button type="button" onClick={handleSnapshot} disabled={snapshotting}>
              Snapshot
            </button>
          </div>
        </div>
        {detailError && <p className={styles.error}>{detailError}</p>}
        {detail && <DetailTables detail={detail} />}
      </section>
    </>
  );
}

function ReadOnlyView({ renderResult }: { renderResult: YdocRenderResult | null }) {
  if (!renderResult) {
    return <p>Loading…</p>;
  }
  if (!renderResult.ok) {
    return (
      <p className={styles.error}>This document isn&apos;t TipTap-compatible: {renderResult.error}</p>
    );
  }

  const clientEntries = Object.entries(renderResult.clients);

  return (
    <div>
      {renderResult.title && <div className={styles.titlePreview}>{renderResult.title}</div>}
      <div className={`${styles.bodyPreview} ${proseStyles.prose}`}>
        {renderResult.body ?? <p className={styles.muted}>Empty document.</p>}
      </div>
      <h3>Clients</h3>
      {clientEntries.length === 0 ? (
        <p className={styles.muted}>No one has edited this document yet.</p>
      ) : (
        <table className={adminStyles.table}>
          <thead>
            <tr>
              <th className={adminStyles.headerCell}>Client ID</th>
              <th className={adminStyles.headerCell}>User ID</th>
            </tr>
          </thead>
          <tbody>
            {clientEntries.map(([clientId, mappedUserId]) => (
              <tr key={clientId} className={adminStyles.row}>
                <td className={adminStyles.cell}>{clientId}</td>
                <td className={adminStyles.cell}>{mappedUserId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EditView({
  documentName,
  userId,
  userName,
  userColor,
}: {
  documentName: string;
  userId: string;
  userName: string;
  userColor: string;
}) {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  // EditView is only ever mounted with a fixed documentName for its whole
  // lifetime (its parent, DocumentPanel, is itself keyed by documentId), so
  // this only ever runs once per instance.
  const ydoc = useMemo(() => new Y.Doc(), []);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;
    let detachIndexeddb: (() => void) | null = null;

    (async () => {
      try {
        const res = await fetch(`/api/ydoc/${documentName}/token`, { method: "POST" });
        if (!res.ok) {
          throw new Error("Failed to authenticate for live editing.");
        }
        const { token, lineage } = (await res.json()) as { token: string; lineage: number };
        if (cancelled) return;

        // The lineage has to be known before connecting — see PLAN.md §11e
        // for why attaching first (or caching the lineage) would let a
        // stale local copy merge into a re-seeded document.
        detachIndexeddb = attachIndexeddb(ydoc, documentName, lineage);

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: documentName,
          document: ydoc,
          token,
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
  }, [documentName, ydoc]);

  if (error) {
    return <p className={styles.error}>{error}</p>;
  }
  if (!provider) {
    return <p>Connecting…</p>;
  }

  return (
    <div>
      <p className={styles.muted}>
        {connectionStatus === "connected" ? "🟢 Live" : connectionStatus === "connecting" ? "🟡 Connecting…" : "🔴 Disconnected"}
      </p>
      <CollabTitleField
        ydoc={ydoc}
        userId={userId}
        userName={userName}
        userColor={userColor}
        onTitleChange={() => {}}
        onEditorReady={() => {}}
      />
      <CollabEditorBody
        provider={provider}
        ydoc={ydoc}
        userId={userId}
        userName={userName}
        userColor={userColor}
        onEditorReady={() => {}}
      />
    </div>
  );
}

function DetailTables({ detail }: { detail: DocDetail }) {
  return (
    <div>
      <h3>ydoc</h3>
      <table className={adminStyles.table}>
        <tbody>
          <tr className={adminStyles.row}>
            <td className={adminStyles.cell}>Created</td>
            <td className={adminStyles.cell}>{new Date(detail.ydoc.createdAt).toLocaleString()}</td>
          </tr>
          <tr className={adminStyles.row}>
            <td className={adminStyles.cell}>Updated</td>
            <td className={adminStyles.cell}>{new Date(detail.ydoc.updatedAt).toLocaleString()}</td>
          </tr>
          <tr className={adminStyles.row}>
            <td className={adminStyles.cell}>Blob size</td>
            <td className={adminStyles.cell}>{detail.ydoc.byteLength} bytes</td>
          </tr>
          <tr className={adminStyles.row}>
            <td className={adminStyles.cell}>State vector size</td>
            <td className={adminStyles.cell}>{detail.ydoc.stateVectorLength} bytes</td>
          </tr>
        </tbody>
      </table>

      <h3>
        ydoc_update ({detail.updateCount} total, last {detail.lastUpdates.length} shown)
      </h3>
      {detail.lastUpdates.length === 0 ? (
        <p className={styles.muted}>No updates yet.</p>
      ) : (
        <table className={adminStyles.table}>
          <thead>
            <tr>
              <th className={adminStyles.headerCell}>id</th>
              <th className={adminStyles.headerCell}>created_at</th>
              <th className={adminStyles.headerCell}>bytes</th>
            </tr>
          </thead>
          <tbody>
            {detail.lastUpdates.map((u) => (
              <tr key={u.id} className={adminStyles.row}>
                <td className={adminStyles.cell}>{u.id}</td>
                <td className={adminStyles.cell}>{new Date(u.createdAt).toLocaleString()}</td>
                <td className={adminStyles.cell}>{u.byteLength}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>ydoc_snapshot ({detail.snapshots.length})</h3>
      {detail.snapshots.length === 0 ? (
        <p className={styles.muted}>No snapshots yet.</p>
      ) : (
        <table className={adminStyles.table}>
          <thead>
            <tr>
              <th className={adminStyles.headerCell}>id</th>
              <th className={adminStyles.headerCell}>created_at</th>
              <th className={adminStyles.headerCell}>last_ydoc_update_id</th>
              <th className={adminStyles.headerCell}>user_id</th>
              <th className={adminStyles.headerCell}>bytes</th>
            </tr>
          </thead>
          <tbody>
            {detail.snapshots.map((s) => (
              <tr key={s.id} className={adminStyles.row}>
                <td className={adminStyles.cell}>{s.id}</td>
                <td className={adminStyles.cell}>{new Date(s.createdAt).toLocaleString()}</td>
                <td className={adminStyles.cell}>{s.lastYdocUpdateId}</td>
                <td className={adminStyles.cell}>{s.userId ?? "(system)"}</td>
                <td className={adminStyles.cell}>{s.byteLength}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
