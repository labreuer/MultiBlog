"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { titleTextFromJSON } from "@/lib/ydoc-render";
import { docTitleOrFallback } from "@/lib/doc-title";
import { useReplayScrub, type ReplayPayload } from "./YdocDebug";
import { useRegisterDocScrubSeek } from "./DocScrubContext";
import { SCRUB_URL_DEBOUNCE_MS, replaceScrubParam } from "@/lib/scrub-url";
import styles from "./DocScrubBar.module.css";

// `live` is true exactly when the slider sits at the newest update — PLAN.md
// §12's frozen reading view uses it (and only it) to decide whether scrubbing
// is the reason the view is frozen, rather than re-deriving "at the end" from
// the slider's own index. `updateId` is that same position's ydoc_update id
// (§12p/§13) — the precise value an annotation posted while scrub-frozen
// records, rather than falling back to the doc's tail at post time.
export type ScrubbedState = { bodyJSON: JSONContent; title: string; live: boolean; updateId: string | null };

type Props = {
  docId: string;
  onScrub: (scrubbed: ScrubbedState) => void;
  // Bumped by the reader clicking the FROZEN flag (PLAN.md §12) — seeks the
  // slider back to the live end so it doesn't sit at a historical position
  // once the body it controls has already snapped back to live. Any change
  // in value triggers the reset; the number itself carries no meaning.
  resetSignal?: number;
  // The ?at= position this page was opened at, already validated by page.tsx
  // (src/lib/scrub-url.ts). Its presence is also what makes this bar load
  // eagerly — see `activate` below. Null on an ordinary visit, which is every
  // visit that didn't follow a link to a revision.
  initialUpdateId?: string | null;
};

type LoadState = "idle" | "loading" | "error";

// Embedded directly in /doc/[slug]'s reading view (PLAN.md §12) — a much
// smaller, lazy sibling of /ydoc-debug's ReplayView (YdocDebug.tsx): no
// clients table, no perf status line, and — the actual point — no fetch and
// no Y.Doc replay machinery (useReplayScrub) at all until the reader
// actually reaches for the slider. Until then this renders one grayed-out
// <input> and nothing else, so a reader who never touches it costs the
// server nothing beyond the page it already loaded. The single exception is
// a URL that names a position (`?at=`, src/lib/scrub-url.ts), which is a
// request for the history and so loads it at once.
export default function DocScrubBar({ docId, onScrub, resetSignal, initialUpdateId }: Props) {
  const [state, setState] = useState<LoadState>("idle");
  const [replay, setReplay] = useState<ReplayPayload | null>(null);

  // A ref rather than the "idle" check living inside a setState updater, which
  // is where it used to be: an updater must be pure, and React calls it twice
  // in development — so the fetch it kicked off ran twice on every activation.
  // Now that ?at= can activate this from an effect as well as from a pointer,
  // that double-fetch would be two eager loads on every seeded page.
  const startedRef = useRef(false);
  const activate = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setState("loading");
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
  }, [docId]);

  // The one case where the bar is *not* lazy: a URL naming a position is a
  // request for that position, so it fetches without waiting to be touched.
  // Until the replay lands the page shows live content — there is no way to
  // render a revision without the log it is replayed from, and rendering it
  // server-side would mean a second copy of the replay machinery for one
  // frame. The queueMicrotask indirection is the same one the reset effect
  // below uses, and for the same lint rule.
  useEffect(() => {
    if (!initialUpdateId) return;
    queueMicrotask(activate);
  }, [initialUpdateId, activate]);

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
    return (
      <LoadedScrubBar
        replay={replay}
        onScrub={onScrub}
        resetSignal={resetSignal}
        initialUpdateId={initialUpdateId}
      />
    );
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

function LoadedScrubBar({
  replay,
  onScrub,
  resetSignal,
  initialUpdateId,
}: {
  replay: ReplayPayload;
  onScrub: (scrubbed: ScrubbedState) => void;
  resetSignal?: number;
  initialUpdateId?: string | null;
}) {
  // -1 — no ?at=, or an id belonging to some other doc's log — falls back to
  // useReplayScrub's own default, the head. Same treatment
  // PostSnapshotScrubBar gives an initialThroughUpdateId it can't place: a
  // position that cannot be seeked to is no position, not an error.
  const initialIndex = initialUpdateId ? replay.updates.findIndex((u) => u.id === initialUpdateId) : -1;
  const { total, index, current, renderResult, seek } = useReplayScrub(
    replay,
    initialIndex === -1 ? undefined : initialIndex,
  );
  // Seeded from a URL counts as having scrubbed — the reader asked for a
  // position, so the line naming it should be there on arrival rather than
  // waiting for a drag that may never come.
  const [hasScrubbed, setHasScrubbed] = useState(initialIndex !== -1);

  const live = index === total - 1;

  // docs/DOCS.md, "The reading view" — the position rides in ?at=, debounced
  // and written with replaceState. src/lib/scrub-url.ts holds the whole rule,
  // including why pushing an entry per position is the wrong shape and why the
  // debounce is load-bearing rather than cosmetic. Re-running on every tick is
  // what makes the debounce coalesce a drag: each tick clears the last timer.
  // The live end writes null, which strips the parameter — so returning to
  // live, whether by dragging or by clicking FROZEN, cleans up after itself.
  useEffect(() => {
    const target = live ? null : (current?.id.toString() ?? null);
    const timer = setTimeout(() => replaceScrubParam(target), SCRUB_URL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live, current]);

  // Materializing the starting position (useReplayScrub's own mount effect)
  // already produces a renderResult before the reader drags anything —
  // pushing it through immediately is what makes the live body/title
  // visibly "become scrubbable" the moment loading finishes, rather than
  // sitting on stale live content until the first manual drag. It is also
  // how a ?at= page reaches its revision: the seeded position reports
  // `live: false`, and DocView freezes on that exactly as it would mid-drag,
  // with no separate arrived-from-a-URL state anywhere.
  useEffect(() => {
    if (!renderResult?.ok) return;
    // The title fragment has no fallback of its own (PLAN.md §12n) — same
    // "Untitled" render-time rule as everywhere else that shows a doc's title.
    const title = docTitleOrFallback(titleTextFromJSON(renderResult.titleJSON));
    onScrub({ bodyJSON: renderResult.bodyJSON, title, live, updateId: current?.id.toString() ?? null });
  }, [renderResult, onScrub, live, current]);

  // PLAN.md §12p/§13 — registers "jump the slider to this ydoc_update id"
  // for AnnotationNode's "at this revision" control, reached through
  // DocScrubContext since the two are sibling subtrees in page.tsx.
  // useCallback keeps this stable across the re-render every scrub tick
  // causes — see useRegisterDocScrubSeek's own note on why an unstable
  // function there would re-render the whole page on every drag.
  const seekToUpdateId = useCallback(
    (updateId: string) => {
      const targetIndex = replay.updates.findIndex((u) => u.id === updateId);
      if (targetIndex !== -1) seek(targetIndex);
    },
    [replay, seek],
  );
  useRegisterDocScrubSeek(seekToUpdateId);

  // Skips on mount — useReplayScrub already starts where it should (the live
  // end, or ?at='s position), so there's nothing to reset yet. Only an actual
  // change in resetSignal (the FROZEN flag being clicked) should seek.
  const resetDidMountRef = useRef(false);
  useEffect(() => {
    if (!resetDidMountRef.current) {
      resetDidMountRef.current = true;
      return;
    }
    if (resetSignal === undefined) return;
    seek(total - 1);
    // queueMicrotask only to keep this out of the "no setState synchronously
    // in an effect body" lint rule's sights — same indirection
    // use-live-doc-content.ts's hoisted-mode effect uses; it still runs
    // before the next paint.
    queueMicrotask(() => setHasScrubbed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seek/total intentionally excluded: resetSignal changing is the only trigger, not their own identity
  }, [resetSignal]);

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
