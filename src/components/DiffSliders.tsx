"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiffSide } from "@/lib/diff-side";
import { sideAtPosition, sideUpdate, sliderPosition, type BuiltSide, type SliderSide, type VersionIndex, type Which } from "@/lib/diff-slider";
import type { VersionAnswer, VersionRequest } from "@/lib/doc-version.worker";
import LocalTime from "./LocalTime";
import styles from "./DiffSliders.module.css";

// docs/FORKS.md "Sliders on the diff page" — a slider for each side of a diff
// whose history the viewer may see, in one bar fixed to the bottom of the
// window, and what they read. A slider names a side and nothing more:
// `DiffView` decides how the pair it names is had.
//
// Two parts, mounted in two places:
//
// - **what is kept for as long as the reader stays on diff pages**, by doc
//   id, in a provider `src/app/diff/layout.tsx` mounts above the page: each
//   doc's index, and the worker that holds each doc's log and builds a
//   version from it (src/lib/doc-version.worker.ts). A link from one diff to
//   another ("Swap sides") mounts the page anew, and what a touch fetched is
//   still here for it;
// - **the bar**, drawn by `DiffView` under the page, since nothing remounts
//   the page while a slider moves.

export type { Which };
const BOTH: readonly Which[] = ["left", "right"];

/**
 * A doc's index. `sought` is every update a fetch has been made for: an index
 * fetched for an update and still without it disagrees with the gate that
 * let the side through, and is not fetched for it again.
 */
type IndexState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; updates: VersionIndex; sought: ReadonlySet<string> };

type Indexes = {
  indexes: Record<string, IndexState>;
  /** Fetches a doc's index, the first time or again, for the update a side is at. One fetch a doc at a time. */
  loadIndex: (docId: string, soughtFor: string | null) => void;
};

const DiffIndexesContext = createContext<Indexes | null>(null);

/** A doc at one version, built in this browser; null when it can't be, and the server is to read the pair. */
type BuildVersion = (docId: string, updateId: string) => Promise<BuiltSide | null>;

const DiffVersionsContext = createContext<BuildVersion | null>(null);

/** The builder of the diff pages' provider, for `DiffView`. */
export function useBuildVersion(): BuildVersion {
  const build = useContext(DiffVersionsContext);
  if (!build) throw new Error("DiffView is drawn under src/app/diff/layout.tsx's provider.");
  return build;
}

/** The worker, and each build it has yet to answer; `"failed"` once it couldn't start or threw, for good. */
type Builder = { worker: Worker; waiting: Map<number, (built: BuiltSide | null) => void>; next: number } | "failed";

export default function DiffIndexesProvider({ children }: { children: ReactNode }) {
  const [indexes, setIndexes] = useState<Record<string, IndexState>>({});
  const inFlightRef = useRef(new Set<string>());
  const soughtRef = useRef(new Map<string, Set<string>>());
  const builderRef = useRef<Builder | null>(null);

  /** The worker, started by the first slider touched. Null where it can't run: every pair is then the server's. */
  const builder = useCallback((): Exclude<Builder, "failed"> | null => {
    if (builderRef.current === "failed") return null;
    if (builderRef.current) return builderRef.current;
    const fail = () => {
      const failed = builderRef.current;
      builderRef.current = "failed";
      if (!failed || failed === "failed") return;
      failed.worker.terminate();
      for (const answer of failed.waiting.values()) answer(null);
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("../lib/doc-version.worker.ts", import.meta.url), { type: "module" });
    } catch {
      // A sandboxed frame, or a browser with workers turned off.
      fail();
      return null;
    }
    const started = { worker, waiting: new Map<number, (built: BuiltSide | null) => void>(), next: 0 };
    worker.onmessage = (event: MessageEvent<VersionAnswer>) => {
      const answer = started.waiting.get(event.data.id);
      started.waiting.delete(event.data.id);
      answer?.(event.data.built);
    };
    worker.onerror = fail;
    builderRef.current = started;
    return started;
  }, []);

  const build = useCallback<BuildVersion>(
    (docId, updateId) =>
      new Promise((resolve) => {
        const running = builder();
        if (!running) {
          resolve(null);
          return;
        }
        const id = running.next++;
        running.waiting.set(id, resolve);
        running.worker.postMessage({ type: "build", id, docId, updateId } satisfies VersionRequest);
      }),
    [builder],
  );

  // Leaving the diff pages ends the worker, and answers what it still owed.
  useEffect(
    () => () => {
      const running = builderRef.current;
      builderRef.current = null;
      if (!running || running === "failed") return;
      running.worker.terminate();
      for (const answer of running.waiting.values()) answer(null);
    },
    [],
  );

  const loadIndex = useCallback((docId: string, soughtFor: string | null) => {
    if (inFlightRef.current.has(docId)) return;
    // The doc's log with its index: a touch is about to be a move, and the
    // first build then finds the log fetched or on its way.
    builder()?.worker.postMessage({ type: "open", docId } satisfies VersionRequest);
    inFlightRef.current.add(docId);
    const sought = soughtRef.current.get(docId) ?? new Set<string>();
    if (soughtFor !== null) sought.add(soughtFor);
    soughtRef.current.set(docId, sought);
    // An index already held stays in use while its newer copy is fetched: a
    // slider being dragged goes on moving over the positions it has.
    setIndexes((prev) => (prev[docId]?.status === "loaded" ? prev : { ...prev, [docId]: { status: "loading" } }));
    (async () => {
      let next: IndexState;
      try {
        // Never a cached copy: a second fetch is made because the first is behind.
        const res = await fetch(`/api/doc/${docId}/versions`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load history (${res.status}).`);
        const data = (await res.json()) as { updates: VersionIndex };
        next = { status: "loaded", updates: data.updates, sought: new Set(sought) };
      } catch {
        next = { status: "error" };
      }
      inFlightRef.current.delete(docId);
      setIndexes((prev) => ({ ...prev, [docId]: next }));
    })();
  }, [builder]);

  const value = useMemo(() => ({ indexes, loadIndex }), [indexes, loadIndex]);
  return (
    <DiffIndexesContext.Provider value={value}>
      <DiffVersionsContext.Provider value={build}>{children}</DiffVersionsContext.Provider>
    </DiffIndexesContext.Provider>
  );
}

/** One side as the bar needs it. */
export type BarSide = SliderSide & {
  docId: string;
  /** Whether the viewer may see this doc's history. */
  slider: boolean;
};

/**
 * What a side's half of the bar shows.
 *
 * - `idle`: nothing fetched; one grayed-out input.
 * - `loading`: the index is on its way.
 * - `error`: the fetch failed, or the index lacks the side's update after a
 *   fetch made for it.
 * - `none`: no slider, for a viewer without the history or a doc with no log.
 * - `ready`: the slider, at `at`.
 */
type HalfView = { kind: "none" | "idle" | "loading" | "error" } | { kind: "ready"; updates: VersionIndex; at: number };

function halfView(side: BarSide, index: IndexState | undefined): HalfView {
  if (!side.slider) return { kind: "none" };
  if (!index) return { kind: "idle" };
  if (index.status !== "loaded") return { kind: index.status };
  const at = sliderPosition(index.updates, side);
  if (at === null) return { kind: "none" };
  if (at !== "behind") return { kind: "ready", updates: index.updates, at };
  const update = sideUpdate(side);
  if (update !== null && index.sought.has(update)) return { kind: "error" };
  // Behind, and its newer copy is being fetched. A side with no version is at
  // the live end of any index; a version this index lacks has no place on it.
  return side.updateId === null ? { kind: "ready", updates: index.updates, at: index.updates.length - 1 } : { kind: "loading" };
}

/**
 * The bar. `left` and `right` are the sides the sliders name: where the
 * reader has put each, or where the address does. `onMove` is told the side a
 * slider has been moved to.
 */
export function DiffSliderBar({ left, right, onMove }: { left: BarSide; right: BarSide; onMove: (which: Which, side: DiffSide) => void }) {
  const context = useContext(DiffIndexesContext);
  if (!context) throw new Error("DiffSliderBar is drawn under src/app/diff/layout.tsx's provider.");
  const { indexes, loadIndex } = context;
  const sides = useMemo(
    () => ({
      left: { docId: left.docId, slider: left.slider, updateId: left.updateId, readAt: left.readAt },
      right: { docId: right.docId, slider: right.slider, updateId: right.updateId, readAt: right.readAt },
    }),
    [left.docId, left.slider, left.updateId, left.readAt, right.docId, right.slider, right.updateId, right.readAt],
  );

  // An index that doesn't hold the update its side is at was fetched before
  // that update was written: fetch it again, once for that update. The
  // queueMicrotask is DocScrubBar's indirection, for the same lint rule.
  useEffect(() => {
    for (const which of BOTH) {
      const side = sides[which];
      const index = indexes[side.docId];
      if (!side.slider || index?.status !== "loaded") continue;
      const update = sideUpdate(side);
      if (update === null || index.sought.has(update)) continue;
      if (sliderPosition(index.updates, side) === "behind") queueMicrotask(() => loadIndex(side.docId, update));
    }
  }, [sides, indexes, loadIndex]);

  if (!left.slider && !right.slider) return null;
  return (
    <div className={styles.bar} data-kind="diff-sliders">
      <div className={styles.inner}>
        {BOTH.map((which) => (
          <SliderHalf
            key={which}
            which={which}
            view={halfView(sides[which], indexes[sides[which].docId])}
            onTouch={() => loadIndex(sides[which].docId, sideUpdate(sides[which]))}
            onMove={(updates, position) => onMove(which, sideAtPosition(sides[which].docId, updates, position))}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One side's half of the bar. **The input is one element through idle,
 * loading and ready**, so the pointer or the focus that asked for the index
 * is still on it when the index arrives. Until then its value is held where
 * it is, and a drag moves nothing.
 */
function SliderHalf({
  which,
  view,
  onTouch,
  onMove,
}: {
  which: Which;
  view: HalfView;
  onTouch: () => void;
  onMove: (updates: VersionIndex, position: number) => void;
}) {
  if (view.kind === "none") return <div className={styles.half} data-side={which} />;
  if (view.kind === "error") {
    return (
      <div className={styles.half} data-side={which}>
        <p className={styles.error}>Couldn&apos;t load this doc&apos;s history.</p>
      </div>
    );
  }
  const ready = view.kind === "ready";
  const total = ready ? view.updates.length : 0;
  return (
    <div className={styles.half} data-side={which} data-loaded={ready ? "" : undefined}>
      <input
        type="range"
        className={ready ? styles.slider : `${styles.slider} ${styles.grayed}`}
        min={0}
        max={ready ? total - 1 : 100}
        value={ready ? view.at : 100}
        disabled={ready && total < 2}
        aria-label={`Scrub the ${which} side through its doc's history`}
        onPointerDown={view.kind === "idle" ? onTouch : undefined}
        onFocus={view.kind === "idle" ? onTouch : undefined}
        onChange={(event) => {
          if (ready) onMove(view.updates, Number(event.target.value));
        }}
      />
      {/* Under the slider, not over it: at the window's bottom edge iPadOS
          takes a drag as its own gesture, so the slider is kept off it. */}
      <p className={styles.line} data-kind="position">
        {view.kind === "loading" && "Loading history…"}
        {ready && (
          <>
            update {view.at + 1} of {total} — <LocalTime value={view.updates[view.at].createdAt} />
          </>
        )}
      </p>
    </div>
  );
}
