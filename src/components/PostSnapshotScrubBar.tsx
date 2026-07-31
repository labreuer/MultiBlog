"use client";

import { useEffect, useState } from "react";
import { extractText } from "@/lib/diff";
import { useReplayScrub, type ReplayPayload } from "./YdocDebug";
import type { YdocRenderResult } from "@/lib/ydoc-render";
import styles from "./PostSnapshotScrubBar.module.css";

export type ScrubSelection = {
  throughUpdateId: string;
  willCreateSnapshot: boolean;
  title: string;
  render: Extract<YdocRenderResult, { ok: true }>;
};

type Props = {
  docId: string;
  onChange: (selection: ScrubSelection | null) => void;
  /**
   * Opens the bar on this update instead of the doc's head — the presently
   * published post's own snapshot mark, so editing /posts/[id]/edit doesn't
   * default to publishing whatever the doc has moved on to since. Ignored if
   * the id doesn't appear in this doc's own log (e.g. it belongs to a
   * different doc, after "Change doc…") — see PostPublisher.tsx.
   */
  initialThroughUpdateId?: string | null;
};

type LoadState = "loading" | "error" | "ready";

// PLAN.md §15c — the publish surface's scrub bar. Sits on the same
// useReplayScrub hook DocScrubBar/ReplayView use (the tricky incremental-vs-
// rebuild replay stays in exactly one place, §11h), but is its own component
// rather than a DocScrubBar variant: this one needs snapshot dots, a
// will-create/will-reuse line, and to report its selection upward — none of
// which DocScrubBar has a use for (§14p's reuse-vs-fork rule). Unlike
// DocScrubBar it loads eagerly, not on first touch: the publish surface needs
// a throughUpdateId before a reader could do anything with the Publish button
// at all.
export default function PostSnapshotScrubBar({ docId, onChange, initialThroughUpdateId }: Props) {
  // docId never actually changes within one mounted instance — the caller
  // keys this component by docId (PostPublisher.tsx) precisely so a doc
  // switch remounts it fresh instead of needing to reset state here.
  const [state, setState] = useState<LoadState>("loading");
  const [replay, setReplay] = useState<ReplayPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/doc/${docId}/replay`);
        if (!res.ok) throw new Error(`Failed to load history (${res.status}).`);
        const data = (await res.json()) as ReplayPayload;
        if (!cancelled) {
          setReplay(data);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (state === "error") {
    return <p className={styles.error}>Couldn&apos;t load this doc&apos;s history.</p>;
  }
  if (state === "loading" || !replay) {
    return <p className={styles.loadingLine}>Loading doc history…</p>;
  }
  return <LoadedScrubBar replay={replay} onChange={onChange} initialThroughUpdateId={initialThroughUpdateId} />;
}

function LoadedScrubBar({
  replay,
  onChange,
  initialThroughUpdateId,
}: {
  replay: ReplayPayload;
  onChange: Props["onChange"];
  initialThroughUpdateId?: string | null;
}) {
  // -1 (not found — a different doc's id, or none given) falls back to
  // useReplayScrub's own default (the head), same as omitting the argument.
  const initialIndex = initialThroughUpdateId
    ? replay.updates.findIndex((u) => u.id === initialThroughUpdateId)
    : -1;
  const { total, index, current, renderResult, snapshots, seek } = useReplayScrub(
    replay,
    initialIndex === -1 ? undefined : initialIndex,
  );
  const atSnapshot = snapshots.some((s) => s.sliderIndex === index);

  useEffect(() => {
    if (total === 0 || !current) {
      onChange(null);
      return;
    }
    if (!renderResult?.ok) return;
    onChange({
      throughUpdateId: current.id.toString(),
      willCreateSnapshot: !atSnapshot,
      title: renderResult.titleJSON ? extractText(renderResult.titleJSON) : "",
      render: renderResult,
    });
    // atSnapshot is derived from snapshots+index, both already dependencies
    // via current/renderResult changing together on every seek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, renderResult, atSnapshot, total]);

  if (total === 0) {
    return (
      <div className={styles.bar}>
        <div className={styles.inner}>
          <p className={styles.muted}>This doc has no edit history yet — nothing to publish.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.bar}>
      <div className={styles.inner}>
        <p className={styles.positionLine}>
          update {index + 1} of {total}
          {current && ` — ${new Date(current.createdAt).toLocaleString()}`}
        </p>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={total - 1}
            value={index}
            aria-label="Scrub through the doc's edit history"
            onChange={(e) => seek(Number(e.target.value))}
          />
          {snapshots.map((snapshot) => (
            <button
              key={snapshot.id}
              type="button"
              className={`${styles.snapshotDot} ${snapshot.sliderIndex === index ? styles.snapshotDotActive : ""}`}
              style={{ left: total > 1 ? `${(snapshot.sliderIndex / (total - 1)) * 100}%` : "0%" }}
              title={`Snapshot taken ${new Date(snapshot.createdAt).toLocaleString()}`}
              aria-label="Jump to this snapshot"
              onClick={() => seek(snapshot.sliderIndex)}
            />
          ))}
        </div>
        <p className={styles.snapshotLine}>
          {atSnapshot
            ? "Publishing will reuse the snapshot at this position."
            : "Publishing will create a new snapshot at this position."}
        </p>
      </div>
    </div>
  );
}
