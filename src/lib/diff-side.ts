// docs/FORKS.md "The route" — one side of `/diff/<left>/<right>`: a doc as
// it is now, `<doc id>`, or the doc at one version, `<doc id>@<update id>`.
// The version is in the path because it is part of what a diff is: a query
// parameter dropped from a pasted URL would turn "what changed since this
// version" into "how they differ now" without saying so. A bare `@1234`,
// since braces would be percent-encoded when the URL is copied. Sides are doc
// ids, never slugs: a slug changes, and an id-only lookup can't be confused
// by a slug that happens to look like `x@1`.
//
// Pure and browser-safe; diff-side.test.ts is its table.

/** Postgres's largest bigint, which every ydoc_update id fits in. */
const MAX_UPDATE_ID = BigInt("9223372036854775807");

/** A doc id as the database holds them: a cuid. Looked up by id alone, never as a slug. */
const DOC_ID = /^[a-z0-9]+$/;

/**
 * An update id from a URL: a positive integer with no leading zero, at most
 * Postgres's largest bigint. Null for anything else, so a larger number is a
 * 404 from here rather than a 500 from the database.
 */
export function parseUpdateId(text: string): bigint | null {
  if (!/^[1-9][0-9]{0,18}$/.test(text)) return null;
  const id = BigInt(text);
  return id <= MAX_UPDATE_ID ? id : null;
}

export type DiffSide = { docId: string; updateId: bigint | null };

/** A side as Next hands the segment over (`@` as `%40`), decoded once; null outside the grammar. */
export function parseDiffSide(param: string): DiffSide | null {
  let text: string;
  try {
    text = decodeURIComponent(param);
  } catch {
    return null;
  }
  const at = text.indexOf("@");
  const docId = at === -1 ? text : text.slice(0, at);
  if (!DOC_ID.test(docId)) return null;
  if (at === -1) return { docId, updateId: null };
  const updateId = parseUpdateId(text.slice(at + 1));
  return updateId === null ? null : { docId, updateId };
}

/** A side's segment: `@` written as it is, which Next routes like `%40`. */
export function diffSideSegment(side: DiffSide): string {
  return side.updateId === null ? side.docId : `${side.docId}@${side.updateId}`;
}

/** The diff page from `left` to `right`: what the left has and the right lacks is shown as removed. */
export function diffPath(left: DiffSide, right: DiffSide): string {
  return `/diff/${diffSideSegment(left)}/${diffSideSegment(right)}`;
}

/** Which side of a pair is the earlier, when the pair has an order. */
export type SideOrder = "left-earlier" | "right-earlier";

/**
 * A pair's lineage, when one of its two docs was forked from the other: which
 * is which, and the parent's update the fork was made at. One generation
 * only. A chain through a grandparent isn't followed: it can pass through a
 * doc the viewer can't read, and a label would tell them the two sides are
 * related through it.
 */
export type PairLineage = {
  parentDocId: string;
  forkDocId: string;
  forkPoint: bigint;
  /**
   * The update the parent is at now, which a parent's side with no version
   * stands for; null when that isn't known, and such a side then has no
   * place against the fork point.
   */
  parentNow: bigint | null;
};

/** The parent's version on a fork-and-parent pair, as lineage reads it; null when the pair isn't one, or the version isn't known. */
function parentVersion(left: DiffSide, right: DiffSide, lineage: PairLineage | null): { parentOnLeft: boolean; version: bigint | null } | null {
  if (lineage === null) return null;
  const parentOnLeft = left.docId === lineage.parentDocId && right.docId === lineage.forkDocId;
  const parentOnRight = right.docId === lineage.parentDocId && left.docId === lineage.forkDocId;
  if (!parentOnLeft && !parentOnRight) return null;
  const parent = parentOnLeft ? left : right;
  return { parentOnLeft, version: parent.updateId ?? lineage.parentNow };
}

/**
 * Whether one side of a pair is earlier than the other (docs/FORKS.md, "Which
 * side is later").
 *
 * - **The same doc on both sides has an order**: the lower update id is the
 *   earlier, and a side with no version, the doc as it is now, is later than
 *   any version. Two sides at one version have none, nor do two sides with no
 *   version.
 * - **A fork and its parent at or before the fork point have one**: the
 *   parent's side is the earlier, whichever version the fork is at, since
 *   everything in the fork came after its seed.
 * - **No other pair has one**: two docs neither of which is the other's
 *   parent, or a fork and its parent past the fork point (`pastForkPoint`).
 */
export function sideOrder(left: DiffSide, right: DiffSide, lineage: PairLineage | null = null): SideOrder | null {
  if (left.docId === right.docId) {
    if (left.updateId === right.updateId) return null;
    if (left.updateId === null) return "right-earlier";
    if (right.updateId === null) return "left-earlier";
    return left.updateId < right.updateId ? "left-earlier" : "right-earlier";
  }
  const parent = parentVersion(left, right, lineage);
  if (parent === null || parent.version === null || parent.version > lineage!.forkPoint) return null;
  return parent.parentOnLeft ? "left-earlier" : "right-earlier";
}

/**
 * Whether the pair is a fork and its parent with the parent's side past the
 * fork point: a pair with no order, where the diff is not what the fork
 * changed, since the parent has changed too.
 */
export function pastForkPoint(left: DiffSide, right: DiffSide, lineage: PairLineage | null): boolean {
  const parent = parentVersion(left, right, lineage);
  return parent !== null && parent.version !== null && parent.version > lineage!.forkPoint;
}
