"use client";

import { useEffect, useState } from "react";
import { ReplayView, type ReplayPayload } from "./YdocDebug";

// The doc-side live-history page's whole client half (PLAN.md §12k) — fetch
// the replay payload, hand it to YdocDebug.tsx's exported ReplayView
// unmodified. No edit-mode toggle, no detail tables, no Snapshot button:
// those are /ydoc-debug-specific (checkpointing a doc is deferred, §12m),
// and DocEditor already covers editing.
export default function DocLiveHistory({ docId }: { docId: string }) {
  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/doc/${docId}/replay`);
        if (!res.ok) throw new Error(`Failed to load history (${res.status}).`);
        const data = (await res.json()) as ReplayPayload;
        if (!cancelled) setReplay(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load history.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (error) {
    return <p style={{ color: "crimson" }}>{error}</p>;
  }
  if (!replay) {
    return <p>Loading…</p>;
  }
  return <ReplayView replay={replay} />;
}
