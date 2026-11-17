"use client";

import { useEffect, useState } from "react";
import { hasChanges, type DiffBlock, type DiffCell, type DiffRow } from "@/lib/doc-diff";
import type { DiffAnswer, DiffRequest } from "@/lib/doc-diff.worker";
import styles from "./DocDiff.module.css";

// docs/FORKS.md "Where the comparing is done" — the rows of the diff page.
// The server has gated both sides and read their blocks; this island hands
// them to a worker, which compares them once, and draws the rows it posts
// back. Nothing is compared on the page's own thread, a small diff included,
// so there is one place `diffRows` runs.
//
// `data-state` is "comparing" until the rows arrive, then "done", or "failed"
// for a worker that couldn't start or threw: what a spec waits on before it
// reads a row.

type State = { status: "comparing" } | { status: "done"; answer: DiffAnswer } | { status: "failed" };

function Cell({ cell, side }: { cell: DiffCell | undefined; side: "old" | "new" }) {
  if (!cell) return <div className={styles.empty} />;
  return (
    <div className={`${styles.cell} ${cell.heading ? styles.heading : ""}`} data-side={side}>
      {cell.spans.map((span, i) =>
        span.change ? (
          <span key={i} className={side === "old" ? styles.removed : styles.added}>
            {span.text}
          </span>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </div>
  );
}

function Row({ row }: { row: DiffRow }) {
  if (row.kind === "unchanged") {
    return <div className={styles.note}>{row.count} unchanged blocks</div>;
  }
  if (row.kind === "past-deadline") {
    return (
      <div className={styles.note} data-kind="past-deadline">
        From here on, changed blocks are shown whole: this diff was taking too long to show word by word.
      </div>
    );
  }
  return (
    <>
      {row.kind === "changed" && row.capped && (
        <div className={styles.note} data-kind="capped">
          Too long to compare word by word: everything between its first change and its last is shown whole.
        </div>
      )}
      <div className={styles.row} data-kind={row.kind}>
        <Cell cell={"old" in row ? row.old : undefined} side="old" />
        <Cell cell={"new" in row ? row.new : undefined} side="new" />
      </div>
    </>
  );
}

export default function DocDiff({ left, right }: { left: DiffBlock[]; right: DiffBlock[] }) {
  const [state, setState] = useState<State>({ status: "comparing" });

  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../lib/doc-diff.worker.ts", import.meta.url), { type: "module" });
    } catch {
      // A sandboxed frame, or a browser with workers turned off.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reporting a failure of this effect's own setup
      setState({ status: "failed" });
      return;
    }
    worker.onmessage = (event: MessageEvent<DiffAnswer>) => setState({ status: "done", answer: event.data });
    worker.onerror = () => setState({ status: "failed" });
    worker.postMessage({ old: left, new: right } satisfies DiffRequest);
    return () => worker.terminate();
  }, [left, right]);

  if (state.status === "comparing") {
    return (
      <p className={styles.status} data-state="comparing">
        Comparing…
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <p className={styles.status} data-state="failed">
        Couldn&apos;t compare these two texts in this browser.{" "}
        {/* A plain link to the page's own address: a reload, with nothing to hydrate before it works. */}
        <a href="">Reload</a> to try again.
      </p>
    );
  }

  const { rows, caps } = state.answer;
  return (
    <div data-state="done">
      {(caps.includes("alignment") || caps.includes("pairing")) && (
        <p className={styles.status} data-kind="unmatched">
          These two texts are too large to match block by block throughout: some blocks are shown removed and added
          without being matched to each other.
        </p>
      )}
      {hasChanges(rows) ? (
        <div className={styles.grid}>
          {rows.map((row, i) => (
            <Row key={i} row={row} />
          ))}
        </div>
      ) : (
        <p className={styles.status} data-kind="no-differences">
          No differences.
        </p>
      )}
    </div>
  );
}
