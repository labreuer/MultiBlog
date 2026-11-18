import { pastForkPoint, sideOrder, type DiffPairSides, type DiffSide, type PairLineage, type SideOrder } from "./diff-side";
import type { DiffBlock } from "./doc-diff";

// docs/FORKS.md "Sliders on the diff page" — what the browser is sent for a
// diff and its sliders, where a slider sits on its doc's index, and how a
// pair a slider names is put together without the server: a side the page
// already shows is kept, and a side moved to a version is built in the
// reader's browser (src/lib/doc-version.worker.ts). The server reads every
// other pair, whole (src/lib/diff-pair.ts).
//
// Pure and browser-safe; diff-slider.test.ts is its table.

export type Which = "left" | "right";

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
  /** The doc's own page: a wiki page's address, else `/doc/<slug>` (`docPagePath`). */
  path: string;
  /**
   * As of the side, or the doc's current title when the side couldn't be
   * read; a wiki page's current name at whatever version (`headedByName`).
   */
  title: string;
  /**
   * A wiki page, headed by its current name at any version (docs/WIKI.md
   * "Diffs"): a side built in the browser keeps the title the server sent
   * rather than the build's title fragment, so a slid-to side and the same
   * pair reloaded agree.
   */
  headedByName: boolean;
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

/**
 * A pair that is a fork and its parent: which doc is which, and the parent's
 * update the fork was made at. What the browser places a parent's side
 * against when it builds one.
 */
export type PairFork = { parentDocId: string; forkDocId: string; forkPoint: string };

export type DiffPairRead = {
  /** When the server last read the pair: the time a side with no version is as of. */
  readAt: string;
  order: SideOrder | null;
  /** A fork and its parent, with the parent's side past the fork point. */
  diverged: boolean;
  /**
   * Set for a fork and its parent, **only to a viewer who may see the
   * parent's history**: no other viewer's browser moves the parent's side,
   * and the fork point is one of the parent's update ids.
   */
  fork: PairFork | null;
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
    isText(side.path) &&
    isText(side.title) &&
    typeof side.headedByName === "boolean" &&
    typeof side.history === "boolean" &&
    isTextOrNull(side.at) &&
    isTextOrNull(side.nowVersion) &&
    (side.blocks === null || Array.isArray(side.blocks))
  );
}

function isPairFork(value: unknown): value is PairFork {
  if (typeof value !== "object" || value === null) return false;
  const fork = value as Record<string, unknown>;
  return isText(fork.parentDocId) && isText(fork.forkDocId) && isText(fork.forkPoint);
}

/** Whether a response body is a pair as the route sends one: what stands between a proxy's error page and the rows. */
export function isDiffPairRead(value: unknown): value is DiffPairRead {
  if (typeof value !== "object" || value === null) return false;
  const pair = value as Record<string, unknown>;
  return (
    isText(pair.readAt) &&
    (pair.order === null || pair.order === "left-earlier" || pair.order === "right-earlier") &&
    typeof pair.diverged === "boolean" &&
    (pair.fork === null || isPairFork(pair.fork)) &&
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

/** How a side of a wanted pair is had without the server: the read on the page, or a build in the browser. */
export type SidePlan = "keep" | "build";

/**
 * How each side of `wanted` can be had without asking the server, given the
 * pair on the page; null when the server must read the pair, which it then
 * does whole.
 *
 * - **A side the page already shows is kept**, a side with no version too:
 *   it stays the doc as it was when last read, which its header says.
 * - **A side moved to a version is built in the browser**, where the viewer
 *   may see that doc's history, which is what gave the side its slider.
 * - **Everything else is the server's**: a side moved to the live end, which
 *   is the doc as it is when next read; a side of another doc than the page
 *   shows there, which no slider makes; a side the server couldn't read.
 */
export function planPair(shown: DiffPairRead, wanted: DiffPairSides): Record<Which, SidePlan> | null {
  const plan = (which: Which): SidePlan | null => {
    const read = shown[which];
    const side = wanted[which];
    if (read.docId !== side.docId) return null;
    if (read.updateId === (side.updateId?.toString() ?? null)) return read.blocks ? "keep" : null;
    return side.updateId !== null && read.history ? "build" : null;
  };
  const left = plan("left");
  const right = plan("right");
  return left && right ? { left, right } : null;
}

/** A side built in the browser: its title as of the version (a wiki page's side keeps its name instead), when the version was written, and its blocks. */
export type BuiltSide = { title: string; at: string; blocks: DiffBlock[] };

/**
 * The pair `wanted` names, from the pair on the page and the sides built for
 * it, as `planPair` planned them: the shape the server sends for that pair.
 *
 * **Which side is later is worked out here as `readDiffPair` works it out**,
 * through the same two functions:
 *
 * - one doc on both sides has the order its two versions give;
 * - a fork and its parent, with the parent's side at a version, are placed
 *   against the fork point the server sent;
 * - any other pair keeps the order on the page. Its order depends on the
 *   parent's side alone, and that side has not moved: a parent's side with no
 *   version is only ever kept, and a parent's side at a version is built only
 *   by a viewer who was sent the fork point.
 */
export function assemblePair(shown: DiffPairRead, wanted: DiffPairSides, built: Partial<Record<Which, BuiltSide>>): DiffPairRead {
  const side = (which: Which): DiffSideRead => {
    const made = built[which];
    if (!made) return shown[which];
    return {
      docId: shown[which].docId,
      updateId: wanted[which].updateId?.toString() ?? null,
      path: shown[which].path,
      title: shown[which].headedByName ? shown[which].title : made.title,
      headedByName: shown[which].headedByName,
      history: true,
      at: made.at,
      nowVersion: null,
      blocks: made.blocks,
    };
  };
  const { left, right } = wanted;
  let order = shown.order;
  let diverged = shown.diverged;
  if (left.docId === right.docId) {
    order = sideOrder(left, right);
    diverged = false;
  } else if (shown.fork) {
    const { parentDocId, forkDocId, forkPoint } = shown.fork;
    const parent = left.docId === parentDocId ? left : right.docId === parentDocId ? right : null;
    if (parent && parent.updateId !== null) {
      const lineage: PairLineage = { parentDocId, forkDocId, forkPoint: BigInt(forkPoint), parentNow: null };
      order = sideOrder(left, right, lineage);
      diverged = pastForkPoint(left, right, lineage);
    }
  }
  return { readAt: shown.readAt, order, diverged, fork: shown.fork, left: side("left"), right: side("right") };
}
