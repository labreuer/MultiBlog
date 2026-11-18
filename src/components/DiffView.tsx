"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { diffPath, parseDiffPath, type DiffPairSides, type DiffSide, type SideOrder } from "@/lib/diff-side";
import {
  DIFF_ADDRESS_MIN_INTERVAL_MS,
  assemblePair,
  isDiffPairRead,
  planPair,
  sideOfRead,
  type BuiltSide,
  type DiffPairRead,
  type DiffSideRead,
} from "@/lib/diff-slider";
import type { DiffBlock } from "@/lib/doc-diff";
import type { DiffAnswer, DiffRequest } from "@/lib/doc-diff.worker";
import { SCRUB_PARAM, SCRUB_URL_DEBOUNCE_MS } from "@/lib/scrub-url";
import DocDiff from "./DocDiff";
import { DiffSliderBar, useBuildVersion, type BarSide, type Which } from "./DiffSliders";
import LocalTime from "./LocalTime";
import styles from "./DiffView.module.css";

// docs/FORKS.md "Sliders on the diff page" — everything on the diff page that
// depends on its pair: the two headers, "Swap sides", the rows and the
// sliders' bar. The page seeds it with the pair the server read; a slider
// then names another, and this gets it, hands both sides' blocks to the
// worker and draws the rows that come back. No navigation is in a slider's
// path, so nothing under the page is mounted anew while one moves: the rows,
// the reader's place and the slider's pointer are kept by not being touched.
//
// Four rules, each undone by a change that looks like a tidy-up:
//
// - **A pair is put together here when it can be, whole, and is the server's
//   otherwise, whole.** A side the page already shows is kept, and a side
//   moved to a version is built in this browser from its doc's log
//   (`planPair` and `assemblePair`, src/lib/diff-slider.ts;
//   src/lib/doc-version.worker.ts), so a move makes no request. Any side
//   neither covers, or a build that can't be made from every record it needs,
//   sends the pair to `/api/diff/<left>/<right>`. Never a pair with a side
//   built from part of what the server would build it from.
// - **One job at a time, and never abandoned for a newer position.** A job is
//   get the pair, compare, draw. A slider moved meanwhile changes which pair
//   is wanted and nothing else; when the job ends, the next starts for the
//   pair wanted then. Aborting on each move would land nothing until a drag
//   paused, since moves arrive faster than a job runs.
// - **The address is written apart from the rows**, by `history.replaceState`
//   once the sliders have rested, since browsers ration history calls
//   (src/lib/scrub-url.ts).
// - **This follows the address, not the pair it was mounted with.** The
//   router restores the page it rendered for an entry, and after a slide that
//   is the pair before the slide under the address after it.

type Pair = DiffPairSides;
/** A pair's address, which is also what two pairs are compared by. */
const keyOf = (pair: Pair): string => diffPath(pair.left, pair.right);
const pairOfRead = (read: DiffPairRead): Pair => ({ left: sideOfRead(read.left), right: sideOfRead(read.right) });

/** The pair on the page: its read, the server's or one put together here, and the worker's rows for it, null until compared or when a side has no text. */
type Shown = { pair: DiffPairRead; answer: DiffAnswer | null };

type Job = { cancelled: boolean; abort: AbortController };

/** The worker couldn't start, or threw: no later job can do better. */
class WorkerFailure extends Error {}

const ORDER_LABELS: Record<SideOrder, Record<Which, "Earlier" | "Later">> = {
  "left-earlier": { left: "Earlier", right: "Later" },
  "right-earlier": { left: "Later", right: "Earlier" },
};

function SideHeader({
  side,
  readAt,
  order,
}: {
  side: DiffSideRead;
  readAt: string;
  /** "Earlier" or "Later" when the pair has an order, and nothing when it has none. */
  order: "Earlier" | "Later" | null;
}) {
  // The doc at this version where its reading view honours `?at=` for this
  // viewer, and the doc as it is now otherwise, at a wiki page's address for
  // one.
  const href = side.updateId !== null && side.history ? `${side.path}?${SCRUB_PARAM}=${side.updateId}` : side.path;
  return (
    <div className={styles.side}>
      {/* Never prefetched: its address changes with every pair drawn. */}
      <Link href={href} prefetch={false} className={styles.sideTitle}>
        {side.title}
      </Link>
      {side.blocks ? (
        <span className={styles.when}>
          {order && <span className={styles.order}>{order}</span>}
          {side.updateId === null ? (
            <>
              when last read, <LocalTime value={readAt} />
            </>
          ) : side.at ? (
            <>
              as it was at <LocalTime value={side.at} />
            </>
          ) : (
            "at an earlier version"
          )}
        </span>
      ) : (
        <span className={styles.when}>
          Couldn&apos;t read this doc&apos;s text. <a href="">Reload</a> to try again.
        </span>
      )}
    </div>
  );
}

export default function DiffView({ initial }: { initial: DiffPairRead }) {
  // The address. Next keeps this in step with a native `replaceState`.
  const pathname = usePathname();
  const addressed = useMemo(() => parseDiffPath(pathname) ?? pairOfRead(initial), [pathname, initial]);

  // **A view mounted with a pair the address doesn't name shows none of it**
  // and fetches the address's. That is Back to a diff whose sliders had
  // moved. On a document load the two always agree, so the server's HTML and
  // the first render here match.
  const [shown, setShown] = useState<Shown | null>(() =>
    keyOf(addressed) === keyOf(pairOfRead(initial)) ? { pair: initial, answer: null } : null,
  );
  // Where the reader has put each slider, as the side it names. Never an
  // index: an index shifts when the doc's index is fetched again.
  const [moved, setMoved] = useState<Record<Which, DiffSide | null>>({ left: null, right: null });
  const [running, setRunning] = useState(false);
  /** The pair whose fetch last failed, by its key. */
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [workerFailed, setWorkerFailed] = useState(false);

  // The pair the sliders name, or the address's where a slider hasn't moved.
  const wanted = useMemo<Pair>(
    () => ({ left: moved.left ?? addressed.left, right: moved.right ?? addressed.right }),
    [moved, addressed],
  );
  const wantedKey = keyOf(wanted);
  const shownKey = shown && keyOf(pairOfRead(shown.pair));

  const jobRef = useRef<Job | null>(null);
  const workerRef = useRef<Worker | null>(null);
  // The pair on the page, for a job to keep sides from. Set before the effect
  // that starts the next job, which is declared below it.
  const shownRef = useRef<DiffPairRead | null>(null);
  useEffect(() => {
    shownRef.current = shown?.pair ?? null;
  }, [shown]);
  const buildVersion = useBuildVersion();

  /**
   * `pair` without the server, or null when the server is to read it: each
   * side kept from the page or built here, as `planPair` says, and no pair at
   * all when a side that needs building can't be built.
   */
  const assemble = useCallback(
    async (pair: Pair): Promise<DiffPairRead | null> => {
      const base = shownRef.current;
      const plan = base && planPair(base, pair);
      if (!base || !plan) return null;
      const built: Partial<Record<Which, BuiltSide>> = {};
      for (const which of ["left", "right"] as const) {
        const side = pair[which];
        if (plan[which] !== "build" || side.updateId === null) continue;
        const made = await buildVersion(side.docId, side.updateId.toString());
        if (!made) return null;
        built[which] = made;
      }
      return assemblePair(base, pair, built);
    },
    [buildVersion],
  );

  /** One worker for the view's life, started by the first compare. */
  const compare = useCallback(
    (left: DiffBlock[], right: DiffBlock[]) =>
      new Promise<DiffAnswer>((resolve, reject) => {
        let worker = workerRef.current;
        if (!worker) {
          try {
            worker = new Worker(new URL("../lib/doc-diff.worker.ts", import.meta.url), { type: "module" });
          } catch {
            // A sandboxed frame, or a browser with workers turned off.
            reject(new WorkerFailure());
            return;
          }
          workerRef.current = worker;
        }
        worker.onmessage = (event: MessageEvent<DiffAnswer>) => resolve(event.data);
        worker.onerror = () => reject(new WorkerFailure());
        worker.postMessage({ old: left, new: right } satisfies DiffRequest);
      }),
    [],
  );

  /** A job for `pair`: put together here or fetched, unless `have` is its read already, then compared and drawn. */
  const startJob = useCallback(
    (pair: Pair, have: DiffPairRead | null) => {
      if (jobRef.current) return;
      const job: Job = { cancelled: false, abort: new AbortController() };
      jobRef.current = job;
      const key = keyOf(pair);
      setRunning(true);
      (async () => {
        let next: Shown | null = null;
        let failure: "load" | "worker" = "load";
        try {
          let read = have ?? (await assemble(pair));
          if (!read && !job.cancelled) {
            const res = await fetch(`/api${key}`, { cache: "no-store", signal: job.abort.signal });
            if (res.status === 401 || res.status === 403 || res.status === 404) {
              // The pair's own address says which, as it does for a pasted
              // one: sign-in with its way back, Forbidden, or the 404. The
              // job is left running, so nothing else starts on the way out.
              if (!job.cancelled) window.location.replace(key);
              return;
            }
            if (!res.ok) throw new Error(`The pair answered ${res.status}.`);
            const body: unknown = await res.json();
            if (!isDiffPairRead(body) || keyOf(pairOfRead(body)) !== key) throw new Error("Not the pair asked for.");
            read = body;
          }
          if (!read) return;
          const { left, right } = read;
          next = { pair: read, answer: left.blocks && right.blocks ? await compare(left.blocks, right.blocks) : null };
        } catch (err) {
          if (err instanceof WorkerFailure) failure = "worker";
        }
        if (job.cancelled) return;
        jobRef.current = null;
        // Plain updates, never a transition: a transition is started again by
        // each move of a slider, and during a drag would not land.
        if (next) {
          setShown(next);
          setFailedFor(null);
        } else if (failure === "worker") {
          setWorkerFailed(true);
        } else {
          setFailedFor(key);
        }
        setRunning(false);
      })();
    },
    [assemble, compare],
  );

  // The next job, whenever none is running and the page isn't the wanted
  // pair's. It runs again when a job ends, which is what picks up the
  // position a slider reached meanwhile.
  useEffect(() => {
    if (running || workerFailed) return;
    if (shown !== null && shownKey === wantedKey) {
      const { left, right } = shown.pair;
      // Its rows are drawn, or a side has no text to compare.
      if (shown.answer !== null || !left.blocks || !right.blocks) return;
      // The server's read, on the first load: compared, with nothing to fetch.
      startJob(wanted, shown.pair);
      return;
    }
    // A pair that couldn't be had is tried again by a move, or by the reader.
    if (failedFor === wantedKey) return;
    startJob(wanted, null);
  }, [running, workerFailed, shown, shownKey, wanted, wantedKey, failedFor, startJob]);

  // Only leaving ends a job early.
  useEffect(
    () => () => {
      const job = jobRef.current;
      if (job) {
        job.cancelled = true;
        job.abort.abort();
      }
      jobRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  const onMove = useCallback((which: Which, side: DiffSide) => {
    setMoved((prev) => {
      const before = prev[which];
      return before !== null && before.updateId === side.updateId ? prev : { ...prev, [which]: side };
    });
  }, []);

  // The address: written once the sliders have rested, whether or not the
  // rows have arrived, and not at all when it already names the pair. One
  // history entry however far they go, and no request.
  const pendingRef = useRef<string | null>(null);
  const lastWriteRef = useRef(Number.NEGATIVE_INFINITY);
  const writeAddress = useCallback(() => {
    const key = pendingRef.current;
    pendingRef.current = null;
    if (key === null) return;
    const here = parseDiffPath(window.location.pathname);
    if (here && keyOf(here) === key) return;
    lastWriteRef.current = performance.now();
    try {
      window.history.replaceState(null, "", `${key}${window.location.search}${window.location.hash}`);
    } catch {
      // Over the engine's history budget (src/lib/scrub-url.ts). The rows are
      // right; the address is stale until the sliders next rest.
    }
  }, []);

  const hasMoved = moved.left !== null || moved.right !== null;
  useEffect(() => {
    if (!hasMoved) return;
    pendingRef.current = wantedKey;
    // The debounce, or longer where the write before this one was recent.
    const wait = Math.max(SCRUB_URL_DEBOUNCE_MS, lastWriteRef.current + DIFF_ADDRESS_MIN_INTERVAL_MS - performance.now());
    const timer = window.setTimeout(writeAddress, wait);
    return () => window.clearTimeout(timer);
  }, [hasMoved, wantedKey, writeAddress]);

  // **A write still waiting is made at once before the reader leaves, and
  // dropped once they have.** A link followed inside the wait would otherwise
  // leave this entry naming the pair before the last move; a write made after
  // leaving would put this diff's address on the page gone to.
  useEffect(() => {
    const beforeLink = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) writeAddress();
    };
    document.addEventListener("click", beforeLink, true);
    window.addEventListener("pagehide", writeAddress);
    return () => {
      document.removeEventListener("click", beforeLink, true);
      window.removeEventListener("pagehide", writeAddress);
      pendingRef.current = null;
    };
  }, [writeAddress]);

  const swapped = diffPath(wanted.right, wanted.left);
  const labels = shown?.pair.order ? ORDER_LABELS[shown.pair.order] : null;
  const failed = failedFor === wantedKey && !running;
  // The rows on the page are for the pair the sliders name, and nothing is on its way.
  const current = shown !== null && shownKey === wantedKey && !running;

  const barSide = (read: DiffSideRead, side: DiffSide): BarSide => ({
    docId: read.docId,
    slider: read.history,
    updateId: side.updateId?.toString() ?? null,
    // The update a side with no version was read at, which says when the bar's index is behind.
    readAt: read.nowVersion,
  });

  let rows: ReactNode = null;
  if (workerFailed) {
    rows = (
      <p className={styles.status} data-state="failed">
        Couldn&apos;t compare these two texts in this browser.{" "}
        {/* A plain link to the page's own address: a reload, with nothing to hydrate before it works. */}
        <a href="">Reload</a> to try again.
      </p>
    );
  } else if (shown === null) {
    rows = failed ? null : (
      <p className={styles.status} data-state="comparing">
        Loading…
      </p>
    );
  } else if (shown.answer !== null) {
    rows = (
      <div data-state={current ? "done" : "comparing"} aria-busy={!current}>
        <DocDiff answer={shown.answer} />
      </div>
    );
  } else if (shown.pair.left.blocks && shown.pair.right.blocks) {
    rows = (
      <p className={styles.status} data-state="comparing">
        Comparing…
      </p>
    );
  }

  const hasSlider = shown !== null && (shown.pair.left.history || shown.pair.right.history);
  return (
    <main className={hasSlider ? `${styles.container} ${styles.withSliders}` : styles.container}>
      <div className={styles.titleRow}>
        <h1>Diff</h1>
        <Link href={swapped} prefetch={false}>
          Swap sides
        </Link>
      </div>
      {shown && (
        <>
          <div className={styles.sides} data-kind="sides">
            <SideHeader side={shown.pair.left} readAt={shown.pair.readAt} order={labels?.left ?? null} />
            <SideHeader side={shown.pair.right} readAt={shown.pair.readAt} order={labels?.right ?? null} />
          </div>
          {shown.pair.order === "right-earlier" && (
            <p className={styles.orderNote} data-kind="later-on-left">
              The later version is on the left, so text marked removed was added since, and text marked added was removed.{" "}
              <Link href={swapped} prefetch={false}>
                Swap sides
              </Link>
            </p>
          )}
          {shown.pair.diverged && (
            <p className={styles.orderNote} data-kind="both-changed">
              Both sides have changed since the fork was made.
            </p>
          )}
        </>
      )}
      {failed && (
        <p className={styles.failure} data-kind="load-failed" role="alert">
          Couldn&apos;t load this version.{" "}
          <button type="button" className={styles.linkButton} onClick={() => setFailedFor(null)}>
            Try again
          </button>
        </p>
      )}
      {rows}
      {shown && (
        <DiffSliderBar left={barSide(shown.pair.left, wanted.left)} right={barSide(shown.pair.right, wanted.right)} onMove={onMove} />
      )}
    </main>
  );
}
