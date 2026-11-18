"use client";

import { memo } from "react";
import { hasChanges, type DiffCell, type DiffRow } from "@/lib/doc-diff";
import type { DiffAnswer } from "@/lib/doc-diff.worker";
import { sameJson } from "@/lib/same-json";
import styles from "./DocDiff.module.css";

// docs/FORKS.md "Where the comparing is done" — the rows of the diff page,
// drawn from one answer of the worker's. `DiffView` asks the worker and
// decides which answer is on the page; nothing here compares anything.
//
// **A row is drawn again only when it differs from the row before it in that
// place**, compared throughout: an answer is a structured clone, so no row
// keeps its identity from one answer to the next. A slider moved one update
// along changes a row or two, and the rest of a long page is left alone.

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

const Row = memo(function Row({ row }: { row: DiffRow }) {
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
}, sameRow);

function sameRow(before: { row: DiffRow }, after: { row: DiffRow }): boolean {
  return sameJson(before.row, after.row);
}

/** One answer's rows. Memoized on the answer, so a slider's own moves, which re-render the view above, draw nothing here. */
export default memo(function DocDiff({ answer }: { answer: DiffAnswer }) {
  const { rows, caps } = answer;
  return (
    <>
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
    </>
  );
});
