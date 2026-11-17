"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { JSONContent } from "@tiptap/react";
import { titleTextFromJSON } from "@/lib/ydoc-render";
import { docTitleOrFallback } from "@/lib/doc-title";
import { useReplayScrub, type ReplayPayload } from "./YdocDebug";
import { useRegisterDocScrubPosition, useRegisterDocScrubSeek, type ScrubPosition } from "./DocScrubContext";
import { SCRUB_URL_DEBOUNCE_MS, replaceScrubParam } from "@/lib/scrub-url";
import { diffPath, type DiffSide } from "@/lib/diff-side";
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
  // The reading view's live tap, as a subscription: the listener is called
  // for each change the tap receives once it has synced (useLiveDocContent's
  // `onLiveUpdate`). What the "changes have come in" note listens to.
  subscribeLiveUpdates?: (listener: () => void) => () => void;
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
export default function DocScrubBar({ docId, onScrub, resetSignal, initialUpdateId, subscribeLiveUpdates }: Props) {
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
        docId={docId}
        replay={replay}
        onScrub={onScrub}
        resetSignal={resetSignal}
        initialUpdateId={initialUpdateId}
        subscribeLiveUpdates={subscribeLiveUpdates}
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

/**
 * "update 12 of 40", then its time. Formatted in the browser from the replay
 * this bar fetched, which is never in the server's HTML, so the hydration
 * rule (CLAUDE.md, "Never call `toLocaleString()`") has nothing to compare.
 */
function positionText(index: number, total: number, createdAt: string, separator: string): string {
  return `update ${index + 1} of ${total}${separator}${new Date(createdAt).toLocaleString()}`;
}

// docs/FORKS.md "Choosing two versions on the scrub bar" — once the history
// has loaded, the bar also offers a diff of two of its positions: this one
// against the doc as it is now, or against a position the reader pinned.
// **The pin is this component's state and nothing else's**: `?at=` stays one
// position, and a URL naming two is the diff's own.
//
// **The links are plain `<a>`s, not `<Link>`s**, so that Back is a load of
// this page at its `?at=`. Next's router keeps the page it rendered for the
// address the reader arrived at, and `?at=` is written afterwards, with
// `replaceState`. So after a client navigation, Back restores that page,
// whose bar never loaded, under a URL that names a position.
function LoadedScrubBar({
  docId,
  replay,
  onScrub,
  resetSignal,
  initialUpdateId,
  subscribeLiveUpdates,
}: {
  docId: string;
  replay: ReplayPayload;
  onScrub: (scrubbed: ScrubbedState) => void;
  resetSignal?: number;
  initialUpdateId?: string | null;
  subscribeLiveUpdates?: (listener: () => void) => () => void;
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
      if (targetIndex === -1) return false;
      seek(targetIndex);
      return true;
    },
    [replay, seek],
  );
  useRegisterDocScrubSeek(seekToUpdateId);

  // docs/FORKS.md — where the slider is, for the Fork dialog to ask as it
  // opens: the update and its time, or null at the live end, where a fork
  // takes the doc as it is now. Kept in a ref written after each render, and
  // read through a getter whose identity never changes, so nothing outside
  // this bar re-renders as the slider moves.
  const positionRef = useRef<ScrubPosition | null>(null);
  useEffect(() => {
    positionRef.current = live || !current ? null : { updateId: current.id.toString(), createdAt: current.createdAt };
  }, [live, current]);
  const getPosition = useCallback(() => positionRef.current, []);
  useRegisterDocScrubPosition(getPosition);

  // Nothing on mount — useReplayScrub already starts where it should (the
  // live end, or ?at='s position). Only an actual change in resetSignal (the
  // FROZEN flag being clicked) seeks. Compared with the value last acted on,
  // and not with a "has mounted" flag: React's StrictMode runs a mount's
  // effects twice in development, the flag is set by the second run, and the
  // bar then left the position `?at=` had just opened it at.
  const lastResetSignalRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastResetSignalRef.current) return;
    lastResetSignalRef.current = resetSignal;
    if (resetSignal === undefined) return;
    seek(total - 1);
    // queueMicrotask only to keep this out of the "no setState synchronously
    // in an effect body" lint rule's sights — same indirection
    // use-live-doc-content.ts's hoisted-mode effect uses; it still runs
    // before the next paint.
    queueMicrotask(() => setHasScrubbed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seek/total intentionally excluded: resetSignal changing is the only trigger, not their own identity
  }, [resetSignal]);

  // The slider index the reader pinned, or null. An index and not an id: the
  // replay is fetched once and never grows, so the two name the same update
  // for as long as this bar is mounted.
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);

  // **The one live part of the bar.** Its history is the replay it fetched,
  // while the reading view's tap goes on receiving updates, so the slider's
  // last position stands for the doc as it was when the history loaded. This
  // mounts when the history has loaded, and the tap reports nothing before
  // its first sync, so one report is a change made since. Nothing is replayed
  // or diffed again; the note says to reload.
  const [changesCameIn, setChangesCameIn] = useState(false);
  useEffect(() => {
    if (!subscribeLiveUpdates) return;
    return subscribeLiveUpdates(() => setChangesCameIn(true));
  }, [subscribeLiveUpdates]);

  if (total === 0) {
    // No update history yet (a doc created but never edited) — nothing to
    // scrub, and rendering an empty slider would just invite a no-op drag.
    return null;
  }

  // A position as a side of a diff. **The live end is a side with no
  // version**, which on the diff page is the doc as it is when that page
  // loads, not the head this bar loaded.
  const sideAt = (i: number): DiffSide => ({
    docId,
    updateId: i === total - 1 ? null : BigInt(replay.updates[i].id),
  });
  const pinned = pinnedIndex === null ? null : replay.updates[pinnedIndex];
  // The older of the two on the left, whichever was pinned.
  const pinnedDiffHref =
    pinnedIndex === null || pinnedIndex === index
      ? null
      : diffPath(sideAt(Math.min(pinnedIndex, index)), sideAt(Math.max(pinnedIndex, index)));

  // The URL trails the slider by its debounce, and leaving the page drops the
  // write still waiting. Following a diff link writes it first, so Back
  // returns to the position the reader left from.
  const settleScrubParam = () => replaceScrubParam(live ? null : (current?.id.toString() ?? null));

  return (
    <div className={styles.bar}>
      <div className={styles.inner}>
        {changesCameIn && (
          <p className={styles.staleLine} data-kind="changes-came-in">
            Changes have come in since this history loaded; reload to include them.
          </p>
        )}
        {pinned && pinnedIndex !== null && (
          <p className={styles.positionLine} data-kind="pinned">
            Pinned: {positionText(pinnedIndex, total, pinned.createdAt, ", ")} ·{" "}
            <button type="button" className={styles.linkButton} onClick={() => setPinnedIndex(null)}>
              Unpin
            </button>
          </p>
        )}
        <div className={styles.controls}>
          {hasScrubbed && current && (
            <span className={styles.positionLine} data-kind="position">
              {positionText(index, total, current.createdAt, " — ")}
            </span>
          )}
          <span className={styles.actions}>
            {pinnedIndex !== index && (
              <button type="button" className={styles.linkButton} onClick={() => setPinnedIndex(index)}>
                Pin this version
              </button>
            )}
            {!live && (
              <a href={diffPath(sideAt(index), sideAt(total - 1))} onClick={settleScrubParam}>
                Diff with now
              </a>
            )}
            {pinnedDiffHref && (
              <a href={pinnedDiffHref} onClick={settleScrubParam}>
                Diff pinned → here
              </a>
            )}
          </span>
        </div>
        <div className={styles.track}>
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
          {pinnedIndex !== null && (
            <span
              className={styles.pinTick}
              data-kind="pin-tick"
              aria-hidden="true"
              style={{ "--pin-at": total > 1 ? pinnedIndex / (total - 1) : 0 } as CSSProperties}
            />
          )}
        </div>
      </div>
    </div>
  );
}
