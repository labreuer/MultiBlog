"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { renderYdocDoc, type YdocRenderResult } from "@/lib/ydoc-render";
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

// Raw payloads for the replay slider, from GET /api/ydoc/[id]/replay.
// Exported (with useReplayScrub below) so DocScrubBar.tsx can replay
// GET /api/doc/[id]/replay's identically-shaped response — "the replay
// slider is what a doc-side scrub bar is built from" (PLAN.md §12a), not a
// doc-flavored copy of it.
export type ReplayPayload = {
  updates: { id: string; createdAt: string; base64: string }[];
  snapshots: { id: string; createdAt: string; lastYdocUpdateId: string; base64: string }[];
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
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  // Bumped on every successful replay fetch, and used as ReplayView's `key`
  // so new data remounts it — which is how its materialized Y.Doc and scrub
  // position get reset without an effect that has to tear them down by hand.
  const [replayVersion, setReplayVersion] = useState(0);
  const [snapshotting, setSnapshotting] = useState(false);

  // Two endpoints, deliberately: /api/ydoc/[id] backs the Refresh tables and
  // is small, while /replay ships every update and snapshot payload so a scrub
  // step touches no network. Bundling them would re-download the whole log on
  // every Refresh click.
  const fetchAll = useCallback(async (): Promise<DocDetail | null> => {
    const [detailRes, replayRes] = await Promise.all([
      fetch(`/api/ydoc/${documentId}`),
      fetch(`/api/ydoc/${documentId}/replay`),
    ]);
    if (!detailRes.ok) {
      setDetailError(`Failed to load document (${detailRes.status}).`);
      setDetail(null);
      return null;
    }
    const data = (await detailRes.json()) as DocDetail;
    setDetailError(null);
    setDetail(data);

    if (replayRes.ok) {
      setReplay((await replayRes.json()) as ReplayPayload);
      setReplayVersion((v) => v + 1);
    } else {
      setDetailError(`Failed to load replay history (${replayRes.status}).`);
    }
    return data;
  }, [documentId]);

  const refresh = useCallback(async () => {
    await fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    // Wrapped rather than called bare so the setState calls inside fetchAll
    // land after an await rather than synchronously in the effect body.
    (async () => {
      await fetchAll();
    })();
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
          replay ? (
            <ReplayView key={replayVersion} replay={replay} />
          ) : (
            <p>Loading…</p>
          )
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

// ---------------------------------------------------------------------------
// Replay slider (PLAN.md §11f)
//
// The read-only view is a scrubber over `ydoc_update`, rebuilt from the newest
// `ydoc_snapshot` at or before the target position rather than from row #1.
// Its point is measurement, not a pleasant scrubbing experience: forward is
// fast because the doc already in hand can be advanced, backward is slow
// because Yjs updates are append-only — there is no un-apply, so going back
// means rebuilding from the base. That asymmetry is the thing on display, and
// nothing here debounces, caches other positions, or precomputes to hide it.
// ---------------------------------------------------------------------------

type PreparedUpdate = { id: bigint; createdAt: string; bytes: Uint8Array };
type PreparedSnapshot = {
  id: string;
  createdAt: string;
  lastYdocUpdateId: bigint;
  bytes: Uint8Array;
  /** Index in `updates` this snapshot sits at, for placing its dot. */
  sliderIndex: number;
};
type Prepared = { updates: PreparedUpdate[]; snapshots: PreparedSnapshot[] };

type ScrubStatus = {
  mode: "forward" | "rebuild";
  fromSnapshot: boolean;
  baseBytes: number;
  deltaBytes: number;
  sinceBase: number;
  appliedThisStep: number;
  elapsedMs: number;
};

// base64 → bytes once, up front, so the timed section below measures Yjs
// replay and nothing else. Base64 is a transport artifact of shipping this
// over JSON; a real reader would fetch binary, so folding its cost into the
// per-scrub measurement would overstate what replay actually costs.
function prepare(replay: ReplayPayload): Prepared {
  const updates: PreparedUpdate[] = replay.updates.map((u) => ({
    id: BigInt(u.id),
    createdAt: u.createdAt,
    bytes: base64ToBytes(u.base64),
  }));

  const snapshots: PreparedSnapshot[] = replay.snapshots.map((s) => {
    const mark = BigInt(s.lastYdocUpdateId);
    // The update this snapshot's high-water mark names. Falls back to the
    // last update at or below the mark if that exact row is somehow gone.
    let sliderIndex = updates.findIndex((u) => u.id === mark);
    if (sliderIndex === -1) {
      sliderIndex = updates.reduce((acc, u, i) => (u.id <= mark ? i : acc), 0);
    }
    return { id: s.id, createdAt: s.createdAt, lastYdocUpdateId: mark, bytes: base64ToBytes(s.base64), sliderIndex };
  });

  return { updates, snapshots };
}

/**
 * The newest snapshot at or before `index`, plus the first update index that
 * still has to be applied on top of it. With no qualifying snapshot the base
 * is update row #1, which invariant 1 (PLAN.md §11b) guarantees is a full
 * state — so replaying from index 0 is always self-sufficient.
 */
function baseFor(prepared: Prepared, index: number): { snapshot: PreparedSnapshot | null; startIndex: number } {
  const targetId = prepared.updates[index].id;

  let snapshot: PreparedSnapshot | null = null;
  for (const candidate of prepared.snapshots) {
    // Ascending by lastYdocUpdateId, so the last one that still qualifies wins.
    if (candidate.lastYdocUpdateId <= targetId) snapshot = candidate;
    else break;
  }
  if (!snapshot) return { snapshot: null, startIndex: 0 };

  const mark = snapshot.lastYdocUpdateId;
  const startIndex = prepared.updates.findIndex((u) => u.id > mark);
  // -1 means the snapshot already covers every update we have; nothing to
  // apply on top of it.
  return { snapshot, startIndex: startIndex === -1 ? prepared.updates.length : startIndex };
}

function formatDelta(bytes: number): string {
  return bytes < 0 ? `−${Math.abs(bytes)}` : `+${bytes}`;
}

export type ReplayScrub = {
  total: number;
  index: number;
  /** The update at `index` — non-null whenever `total > 0`. */
  current: PreparedUpdate | null;
  status: ScrubStatus | null;
  renderResult: YdocRenderResult | null;
  snapshots: PreparedSnapshot[];
  seek: (target: number) => void;
};

// The replay/seek machinery, shared by ReplayView below (unmodified UI, for
// /ydoc-debug), DocScrubBar.tsx's lazy-loaded, live-body-swapping instance
// embedded in /doc/[slug]'s own reading view (PLAN.md §12), and
// PostSnapshotScrubBar.tsx's publish surface (§15c) — the tricky part
// (incremental-vs-rebuild replay, §11h) stays in exactly one place either
// way. initialIndex opens the scrub bar somewhere other than the log's head —
// PostSnapshotScrubBar's only use for it — and is clamped the same way any
// other seek target is; omitted (every other caller) it defaults to the head,
// unchanged from before this parameter existed.
export function useReplayScrub(replay: ReplayPayload, initialIndex?: number): ReplayScrub {
  const prepared = useMemo(() => prepare(replay), [replay]);
  const total = prepared.updates.length;
  const startIndex = Math.min(Math.max(initialIndex ?? total - 1, 0), Math.max(total - 1, 0));

  // Mutable replay machinery, deliberately refs rather than state: a
  // re-render per applyUpdate would swamp the very measurement this exists to
  // take.
  const docRef = useRef<Y.Doc | null>(null);
  const baseSnapshotIdRef = useRef<string | null>(null);
  const indexRef = useRef(-1);

  const [index, setIndex] = useState(startIndex);
  const [renderResult, setRenderResult] = useState<YdocRenderResult | null>(null);
  const [status, setStatus] = useState<ScrubStatus | null>(null);

  const seek = useCallback(
    (target: number) => {
      if (total === 0) return;
      const clamped = Math.min(Math.max(target, 0), total - 1);
      const required = baseFor(prepared, clamped);

      // Forward from the doc already in hand is the only incremental path Yjs
      // allows. It's unavailable going backward, and also when a *newer*
      // snapshot now covers the target — in which case rebuilding from that
      // snapshot is both correct and cheaper than replaying the deltas
      // between here and there. That second case is the only way a snapshot
      // ever earns its keep on a forward jump.
      const incremental =
        docRef.current !== null &&
        clamped >= indexRef.current &&
        (required.snapshot?.id ?? null) === baseSnapshotIdRef.current;

      let appliedThisStep = 0;
      try {
        const t0 = performance.now();
        if (incremental) {
          const doc = docRef.current!;
          for (let i = indexRef.current + 1; i <= clamped; i++) {
            Y.applyUpdate(doc, prepared.updates[i].bytes);
            appliedThisStep++;
          }
        } else {
          const doc = new Y.Doc();
          if (required.snapshot) Y.applyUpdate(doc, required.snapshot.bytes);
          for (let i = required.startIndex; i <= clamped; i++) {
            Y.applyUpdate(doc, prepared.updates[i].bytes);
            appliedThisStep++;
          }
          const previous = docRef.current;
          docRef.current = doc;
          baseSnapshotIdRef.current = required.snapshot?.id ?? null;
          previous?.destroy();
        }
        const elapsedMs = performance.now() - t0;
        indexRef.current = clamped;

        // Outside the timer on purpose: encoding the whole document just to
        // report its size is pure instrumentation, not part of the rebuild.
        // It is still real per-step cost the page pays, and on a large
        // document it can easily exceed the rebuild it's reporting on — so
        // don't read the millisecond figure as this view's total step cost.
        const baseBytes = required.snapshot
          ? required.snapshot.bytes.byteLength
          : prepared.updates[0].bytes.byteLength;
        const resultBytes = Y.encodeStateAsUpdate(docRef.current!).byteLength;

        setIndex(clamped);
        setStatus({
          mode: incremental ? "forward" : "rebuild",
          fromSnapshot: required.snapshot !== null,
          baseBytes,
          deltaBytes: resultBytes - baseBytes,
          sinceBase: clamped - required.startIndex + 1,
          appliedThisStep,
          elapsedMs,
        });
        setRenderResult(renderYdocDoc(docRef.current!));
      } catch (err) {
        // A document whose bytes aren't a valid Yjs update at all (the
        // --garbage fixture) throws here rather than in the renderer. Reset
        // so the next seek rebuilds from scratch instead of continuing from
        // a half-applied doc.
        docRef.current?.destroy();
        docRef.current = null;
        baseSnapshotIdRef.current = null;
        indexRef.current = -1;
        setIndex(clamped);
        setStatus(null);
        setRenderResult({
          ok: false,
          error: `Couldn't replay this document's updates: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [prepared, total],
  );

  // Materialize startIndex (the newest position, unless a caller asked for
  // somewhere else) on mount. This component is keyed by its parent on the
  // replay-fetch version, so "mount" is also what happens after a Refresh —
  // which is how the Y.Doc gets rebuilt against new data without a separate
  // teardown path.
  //
  // set-state-in-effect is disabled deliberately rather than worked around.
  // The materialized Y.Doc *is* an external system in the sense the rule
  // means: a mutable non-React object whose construction is this component's
  // entire job, and whose result has to reach React state before anything can
  // render. The alternatives are worse — a lazy useState initializer would do
  // the same work as a side effect during render, and under StrictMode's
  // double invocation it would report the second (incremental, 0-update) pass
  // as the initial measurement, which is exactly the number this view exists
  // to show correctly.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    seek(startIndex);
    return () => {
      docRef.current?.destroy();
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    total,
    index,
    current: total > 0 ? prepared.updates[index] : null,
    status,
    renderResult,
    snapshots: prepared.snapshots,
    seek,
  };
}

export function ReplayView({ replay }: { replay: ReplayPayload }) {
  const { total, index, current, status, renderResult, snapshots, seek } = useReplayScrub(replay);

  if (total === 0) {
    return <p className={styles.muted}>This document has no update history.</p>;
  }

  return (
    <div>
      <div className={styles.replay}>
        <p className={styles.positionLine}>
          update {index + 1} of {total} — id {current!.id.toString()} —{" "}
          {new Date(current!.createdAt).toLocaleString()}
        </p>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={total - 1}
            value={index}
            aria-label="Scrub through ydoc update history"
            onChange={(e) => seek(Number(e.target.value))}
          />
          {snapshots.map((snapshot) => (
            <button
              key={snapshot.id}
              type="button"
              className={`${styles.snapshotDot} ${snapshot.sliderIndex === index ? styles.snapshotDotActive : ""}`}
              style={{ left: total > 1 ? `${(snapshot.sliderIndex / (total - 1)) * 100}%` : "0%" }}
              title={`snapshot ${snapshot.id}\n${new Date(snapshot.createdAt).toLocaleString()}\n${snapshot.bytes.byteLength} B\nthrough update ${snapshot.lastYdocUpdateId.toString()}`}
              aria-label={`Jump to snapshot through update ${snapshot.lastYdocUpdateId.toString()}`}
              onClick={() => seek(snapshot.sliderIndex)}
            />
          ))}
        </div>
        <p className={styles.statusLine} data-testid="replay-status">
          {status
            ? `${status.mode} · ${status.fromSnapshot ? "snapshot" : "base row #1"} ${status.baseBytes} B ` +
              `(${formatDelta(status.deltaBytes)}) · ${status.sinceBase} since ` +
              `${status.fromSnapshot ? "snapshot" : "row #1"} (${status.appliedThisStep}) · ` +
              `${status.elapsedMs.toFixed(1)}ms`
            : "—"}
        </p>
      </div>
      <ReplayContent renderResult={renderResult} />
    </div>
  );
}

function ReplayContent({ renderResult }: { renderResult: YdocRenderResult | null }) {
  if (!renderResult) {
    return <p>Loading…</p>;
  }
  if (!renderResult.ok) {
    // Rendered verbatim — the producer (renderYdocDoc, or the replay step in
    // ReplayView) supplies the whole sentence, so a corrupt update log and an
    // un-renderable schema don't both get reported as the latter.
    return <p className={styles.error}>{renderResult.error}</p>;
  }

  const clientEntries = Object.entries(renderResult.clients);

  return (
    <div>
      {renderResult.title && <div className={styles.titlePreview}>{renderResult.title}</div>}
      <div className={`${styles.bodyPreview} ${proseStyles.prose}`} data-testid="replay-body">
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
