"use client";

import { useCallback, useEffect, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { extractText } from "@/lib/diff";
import { docTitleOrFallback } from "@/lib/doc-title";
import { useReplayScrub, type ReplayPayload } from "./YdocDebug";
import styles from "./DocScrubBar.module.css";

export type ScrubbedState = { bodyJSON: JSONContent; title: string };

type Props = {
  docId: string;
  onScrub: (scrubbed: ScrubbedState) => void;
};

type LoadState = "idle" | "loading" | "error";

// Embedded directly in /doc/[slug]'s reading view (PLAN.md §12) — a much
// smaller, lazy sibling of /ydoc-debug's ReplayView (YdocDebug.tsx): no
// clients table, no perf status line, and — the actual point — no fetch and
// no Y.Doc replay machinery (useReplayScrub) at all until the reader
// actually reaches for the slider. Until then this renders one grayed-out
// <input> and nothing else, so a reader who never touches it costs the
// server nothing beyond the page it already loaded.
export default function DocScrubBar({ docId, onScrub }: Props) {
  const [state, setState] = useState<LoadState>("idle");
  const [replay, setReplay] = useState<ReplayPayload | null>(null);

  const activate = useCallback(() => {
    setState((prev) => {
      if (prev !== "idle") return prev;
      (async () => {
        try {
          const res = await fetch(`/api/doc/${docId}/replay`);
          if (!res.ok) throw new Error(`Failed to load history (${res.status}).`);
          const data = (await res.json()) as ReplayPayload;
          setReplay(data);
        } catch {
          setState("error");
        }
      })();
      return "loading";
    });
  }, [docId]);

  if (state === "error") {
    return (
      <div className={styles.bar}>
        <div className={styles.inner}>
          <p className={styles.error}>Couldn&apos;t load this doc&apos;s history.</p>
        </div>
      </div>
    );
  }

  if (replay) {
    return <LoadedScrubBar replay={replay} onScrub={onScrub} />;
  }

  return (
    <div className={styles.bar}>
      <div className={styles.inner}>
        {state === "loading" && <p className={styles.loadingLine}>Loading history…</p>}
        <input
          type="range"
          className={`${styles.slider} ${styles.sliderGrayed}`}
          defaultValue={100}
          min={0}
          max={100}
          aria-label="Scrub through this doc's edit history"
          onPointerDown={activate}
          onFocus={activate}
        />
      </div>
    </div>
  );
}

function LoadedScrubBar({ replay, onScrub }: { replay: ReplayPayload; onScrub: (scrubbed: ScrubbedState) => void }) {
  const { total, index, current, renderResult, seek } = useReplayScrub(replay);
  const [hasScrubbed, setHasScrubbed] = useState(false);

  // Materializing the latest position (useReplayScrub's own mount effect)
  // already produces a renderResult before the reader drags anything —
  // pushing it through immediately is what makes the live body/title
  // visibly "become scrubbable" the moment loading finishes, rather than
  // sitting on stale live content until the first manual drag.
  useEffect(() => {
    if (!renderResult?.ok) return;
    // The title fragment has no fallback of its own (PLAN.md §12n) — same
    // "Untitled" render-time rule as everywhere else that shows a doc's title.
    const title = docTitleOrFallback(renderResult.titleJSON ? extractText(renderResult.titleJSON) : "");
    onScrub({ bodyJSON: renderResult.bodyJSON, title });
  }, [renderResult, onScrub]);

  if (total === 0) {
    // No update history yet (a doc created but never edited) — nothing to
    // scrub, and rendering an empty slider would just invite a no-op drag.
    return null;
  }

  return (
    <div className={styles.bar}>
      <div className={styles.inner}>
        {hasScrubbed && current && (
          <p className={styles.positionLine}>
            update {index + 1} of {total} — {new Date(current.createdAt).toLocaleString()}
          </p>
        )}
        <input
          type="range"
          className={styles.slider}
          min={0}
          max={total - 1}
          value={index}
          aria-label="Scrub through this doc's edit history"
          onChange={(e) => {
            setHasScrubbed(true);
            seek(Number(e.target.value));
          }}
        />
      </div>
    </div>
  );
}
