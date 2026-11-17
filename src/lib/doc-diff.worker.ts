import { DIFF_DEADLINE_MS, diffRows, type DiffBlock, type DiffRow } from "./doc-diff";
import type { DiffCap } from "./diff-text";

// docs/FORKS.md "Where the comparing is done" — the diff page's worker: one
// request, two sides' blocks, answered once with their rows. In a worker and
// not on the page's own thread because the engine doesn't yield: the page
// scrolls while this runs, and leaving the page ends it.
//
// **Imports doc-diff.ts and, through it, block-align.ts and diff-text.ts,
// and nothing else.** An import that reaches `@/lib/diff` or a chip helper
// puts the chip registry in every reader's worker bundle.

export type DiffRequest = { old: DiffBlock[]; new: DiffBlock[] };

/** The rows, and each size cap that bit, once apiece (docs/MCP.md §6, "Size guards"). */
export type DiffAnswer = { rows: DiffRow[]; caps: DiffCap[] };

// The page's tsconfig has the DOM's types and not a worker's, where `self` is
// a window whose `postMessage` wants a target origin.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DiffRequest>) => void) | null;
  postMessage(answer: DiffAnswer): void;
};

scope.onmessage = (event) => {
  const caps = new Set<DiffCap>();
  const rows = diffRows(event.data.old, event.data.new, {
    deadline: { ms: DIFF_DEADLINE_MS, now: () => performance.now() },
    onCap: (cap) => caps.add(cap),
  });
  scope.postMessage({ rows, caps: [...caps] });
};
