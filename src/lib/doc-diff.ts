import { alignBlocks, diffRuns } from "./block-align";
import type { DiffCap, OnCap } from "./diff-text";

// docs/FORKS.md "What is compared" — the rows of the diff page, the left
// side's blocks against the right's: the pure half, so its rules can be
// unit-tested without a doc. The engine is the pair MCP's `since` runs:
// alignBlocks pairs the blocks, identical ones anchoring, and diffRuns diffs
// each changed pair word by word. Text runs only, not formatting.
//
// **Imports the engine and nothing else**: it runs in a browser worker
// (doc-diff.worker.ts), whose bundle is this file, block-align.ts and
// diff-text.ts ("Where the comparing is done").

/** A block as the diff reads it: its text form (`blockText`), its node type, and whether it is a heading. */
export type DiffBlock = { text: string; type: string; heading: boolean };

/** A stretch of a block's text, `change` when it is what this side lost or gained. */
export type DiffSpan = { text: string; change: boolean };
export type DiffCell = { spans: DiffSpan[]; heading: boolean };

export type DiffRow =
  | { kind: "same"; old: DiffCell; new: DiffCell }
  /**
   * A block on both sides whose text differs. `capped` when the word diff's
   * cap bit, so everything between its first change and its last is shown
   * whole; `whole` when the deadline had passed and it wasn't diffed at all.
   */
  | { kind: "changed"; old: DiffCell; new: DiffCell; capped?: true; whole?: true }
  | { kind: "deleted"; old: DiffCell }
  | { kind: "added"; new: DiffCell }
  /** A stretch of unchanged blocks, folded away. */
  | { kind: "unchanged"; count: number }
  /** Where the deadline passed: every changed row after this one is `whole`. */
  | { kind: "past-deadline" };

/**
 * An empty paragraph added or deleted is left out: the first time a doc
 * ending in anything but a paragraph is opened in the editor, StarterKit's
 * TrailingNode appends one, credited to whoever opened it, and a diff would
 * otherwise show it on a doc nobody had touched. Any other block without
 * text, a horizontal rule say, is still shown.
 */
function isEmptyParagraph(block: DiffBlock): boolean {
  return block.type === "paragraph" && block.text === "";
}

function whole(block: DiffBlock, change: boolean): DiffCell {
  return { spans: block.text ? [{ text: block.text, change }] : [], heading: block.heading };
}

/** How many unchanged blocks are kept either side of a change before the rest are folded. */
export const DIFF_CONTEXT = 1;

/**
 * How long a diff may take before its remaining changed pairs are shown
 * whole, in milliseconds. A first guess (TODO.md, "The diff engine's size
 * guards are first guesses").
 */
export const DIFF_DEADLINE_MS = 3000;

export type DiffRowsOptions = {
  /** Unchanged blocks kept either side of a change; `DIFF_CONTEXT` by default. */
  context?: number;
  /**
   * A bound on the time, with the clock that measures it, passed in so that
   * this stays a pure function. Counted from the call, alignment included,
   * and checked between changed pairs: the alignment is one call and can't be
   * interrupted, so its own cap bounds that. No deadline without it.
   */
  deadline?: { ms: number; now: () => number };
  /** Told each size cap that bites, by name: the alignment's and pairing's, and the word diff's once per capped row. */
  onCap?: OnCap;
};

/**
 * The rows for `oldBlocks` against `newBlocks`. Unchanged blocks more than
 * `context` away from any change are folded into one `unchanged` row per
 * stretch, unless the stretch is a single block. Two sides with no change
 * come back as one folded stretch, or as nothing for two empty docs.
 */
export function diffRows(
  oldBlocks: readonly DiffBlock[],
  newBlocks: readonly DiffBlock[],
  opts: DiffRowsOptions = {},
): DiffRow[] {
  const { context = DIFF_CONTEXT, deadline, onCap } = opts;
  const until = deadline ? deadline.now() + deadline.ms : null;
  const pairs = alignBlocks(
    oldBlocks.map((b) => b.text),
    newBlocks.map((b) => b.text),
    undefined,
    "read",
    onCap,
  );
  const rows: DiffRow[] = [];
  let late = false;
  for (const pair of pairs) {
    const before = pair.old !== null ? oldBlocks[pair.old] : null;
    const after = pair.new !== null ? newBlocks[pair.new] : null;
    if (before && after) {
      if (before.text === after.text) {
        rows.push({ kind: "same", old: whole(before, false), new: whole(after, false) });
        continue;
      }
      if (!late && until !== null && deadline!.now() >= until) {
        late = true;
        rows.push({ kind: "past-deadline" });
      }
      if (late) {
        rows.push({ kind: "changed", old: whole(before, true), new: whole(after, true), whole: true });
        continue;
      }
      let capped = false;
      const runs = diffRuns(before.text, after.text, (cap: DiffCap) => {
        capped = true;
        onCap?.(cap);
      });
      rows.push({
        kind: "changed",
        old: { heading: before.heading, spans: runs.filter((r) => r.type !== "insert").map((r) => ({ text: r.text, change: r.type === "delete" })) },
        new: { heading: after.heading, spans: runs.filter((r) => r.type !== "delete").map((r) => ({ text: r.text, change: r.type === "insert" })) },
        ...(capped ? { capped: true as const } : {}),
      });
    } else if (before) {
      if (!isEmptyParagraph(before)) rows.push({ kind: "deleted", old: whole(before, true) });
    } else if (after) {
      if (!isEmptyParagraph(after)) rows.push({ kind: "added", new: whole(after, true) });
    }
  }
  return fold(rows, context);
}

function fold(rows: DiffRow[], context: number): DiffRow[] {
  const keep = rows.map(() => false);
  rows.forEach((row, i) => {
    if (row.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const folded: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) {
      folded.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    if (j - i === 1) folded.push(rows[i]);
    else folded.push({ kind: "unchanged", count: j - i });
    i = j;
  }
  return folded;
}

/** Whether any row is a change, rather than only unchanged blocks. */
export function hasChanges(rows: readonly DiffRow[]): boolean {
  return rows.some((row) => row.kind === "changed" || row.kind === "added" || row.kind === "deleted");
}
