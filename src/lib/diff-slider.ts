import type { DiffSide, SideOrder } from "./diff-side";
import type { DiffBlock } from "./doc-diff";

// docs/FORKS.md "Sliders on the diff page" — what the browser is sent for a
// diff and its sliders, and where a slider sits on its doc's index. A slider
// names a side; the server builds it, as it does for any `<id>@<update id>`
// (src/lib/diff-pair.ts), and no update's bytes reach the browser.
//
// Pure and browser-safe; diff-slider.test.ts is its table.

/**
 * The least time between two writes of the diff page's address. **A write is
 * two history calls**: the page's `replaceState`, and the one Next's router
 * answers it with. WebKit throws past roughly 100 calls in 30 seconds
 * (src/lib/scrub-url.ts), and the router's call throws where nothing catches
 * it. The debounce alone allows 150 from a slider that rests and moves on for
 * half a minute, which a slow drag over a short history does; this allows 80.
 */
export const DIFF_ADDRESS_MIN_INTERVAL_MS = 750;

/** A doc's update ids and their times (ISO strings), oldest first: `/api/doc/[id]/versions`. */
export type VersionIndex = { id: string; createdAt: string }[];

/**
 * One side of a pair as the server read it. Plain JSON, ids as strings and
 * times as ISO strings: the diff page's prop and `/api/diff/[left]/[right]`'s
 * body are this one shape.
 */
export type DiffSideRead = {
  docId: string;
  /** The side's version; null for the doc as it was when read. */
  updateId: string | null;
  slug: string;
  /** As of the side, or the doc's current title when the side couldn't be read. */
  title: string;
  /** Whether this viewer may see the doc's history: the side has a slider, and the doc's reading view honours `?at=`. */
  history: boolean;
  /** When the side's version was written; null for a side with none. */
  at: string | null;
  /**
   * The update a side with no version was read at. **Null for a side whose
   * history the viewer may not see**: it is the id of the log's newest
   * update, which is not theirs to learn.
   */
  nowVersion: string | null;
  /** Null when the server couldn't read the side's text. */
  blocks: DiffBlock[] | null;
};

export type DiffPairRead = {
  /** When the server read the pair. */
  readAt: string;
  order: SideOrder | null;
  /** A fork and its parent, with the parent's side past the fork point. */
  diverged: boolean;
  left: DiffSideRead;
  right: DiffSideRead;
};

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function isDiffSideRead(value: unknown): value is DiffSideRead {
  if (typeof value !== "object" || value === null) return false;
  const side = value as Record<string, unknown>;
  return (
    isText(side.docId) &&
    isTextOrNull(side.updateId) &&
    isText(side.slug) &&
    isText(side.title) &&
    typeof side.history === "boolean" &&
    isTextOrNull(side.at) &&
    isTextOrNull(side.nowVersion) &&
    (side.blocks === null || Array.isArray(side.blocks))
  );
}

/** Whether a response body is a pair as the route sends one: what stands between a proxy's error page and the rows. */
export function isDiffPairRead(value: unknown): value is DiffPairRead {
  if (typeof value !== "object" || value === null) return false;
  const pair = value as Record<string, unknown>;
  return (
    isText(pair.readAt) &&
    (pair.order === null || pair.order === "left-earlier" || pair.order === "right-earlier") &&
    typeof pair.diverged === "boolean" &&
    isDiffSideRead(pair.left) &&
    isDiffSideRead(pair.right)
  );
}

/** A read side as an address names it. */
export function sideOfRead(side: Pick<DiffSideRead, "docId" | "updateId">): DiffSide {
  return { docId: side.docId, updateId: side.updateId === null ? null : BigInt(side.updateId) };
}

/** What is known of a side: its version, or for a side with none, the update it was read at. */
export type SliderSide = { updateId: string | null; readAt: string | null };

/** The update a side is at: its version, or the update a side with no version was read at. Null when neither is known. */
export function sideUpdate(side: SliderSide): string | null {
  return side.updateId ?? side.readAt;
}

/**
 * Where a side sits on its doc's index.
 *
 * - A side at a version sits on that update.
 * - A side with no version sits at the last position, the live end, also when
 *   the index holds updates later than the one it was read at.
 * - `"behind"` when the index doesn't hold the update the side is at: its
 *   version, or an update past the index's last for a side with no version.
 *   A log only grows, so the index was fetched before that update was
 *   written, and is to be fetched again.
 * - `null` for a doc with no log, which has no slider.
 */
export function sliderPosition(updates: VersionIndex, side: SliderSide): number | "behind" | null {
  if (updates.length === 0) return null;
  const last = updates.length - 1;
  if (side.updateId !== null) {
    const at = updates.findIndex((update) => update.id === side.updateId);
    return at === -1 ? "behind" : at;
  }
  if (side.readAt !== null && BigInt(side.readAt) > BigInt(updates[last].id)) return "behind";
  return last;
}

/**
 * The side a position stands for. **The last position is the live end, a
 * side with no version**: the doc as it is when next read, not the head this
 * index held. So a slider never writes `@<the last id>`.
 */
export function sideAtPosition(docId: string, updates: VersionIndex, position: number): DiffSide {
  return { docId, updateId: position >= updates.length - 1 ? null : BigInt(updates[position].id) };
}
