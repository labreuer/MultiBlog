import type { Session } from "next-auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canUserReadDoc, canUserSeeDocHistory, canUserSeeDocVersion } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { isDocVersion, loadDocStateAt, loadDocStateNow } from "@/lib/doc-state";
import { parseDiffSide, pastForkPoint, sideOrder, type DiffSide, type PairLineage } from "@/lib/diff-side";
import type { DiffBlock } from "@/lib/doc-diff";
import type { DiffPairRead, DiffSideRead } from "@/lib/diff-slider";

// docs/FORKS.md "Who may see one" — the gate and the read of a diff's pair,
// for its two callers: the page (`/diff/[left]/[right]`) and the route a
// slider asks (`/api/diff/[left]/[right]`). **Both go through these two
// functions and hold no check of their own**: a rule written into one caller
// binds one front door, and the other then answers what the first refuses.
//
// Server-only: it reads the session's user and the database.

const DOC_SELECT = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  deletedByUserId: true,
  // Whether one side was forked from the other, for "Which side is later".
  forkedFromDocId: true,
  forkedFromUpdateId: true,
} as const;

type PairDoc = { id: string; forkedFromDocId: string | null; forkedFromUpdateId: bigint | null };

/**
 * Which of the pair's two docs was forked from the other, if either was. One
 * generation only (docs/FORKS.md, "Which side is later"). Both docs have
 * passed the gate by the time this is read, so it names nothing the viewer
 * can't read. `parentNow` is filled in once the sides are loaded.
 */
function pairLineage(left: PairDoc, right: PairDoc): Omit<PairLineage, "parentNow"> | null {
  for (const [fork, parent] of [
    [left, right],
    [right, left],
  ] as const) {
    if (fork.forkedFromDocId === parent.id && fork.forkedFromUpdateId !== null) {
      return { parentDocId: parent.id, forkDocId: fork.id, forkPoint: fork.forkedFromUpdateId };
    }
  }
  return null;
}

export type GatedSide = { side: DiffSide; doc: { id: string; slug: string; title: string }; history: boolean };
export type GatedPair = { left: GatedSide; right: GatedSide; lineage: Omit<PairLineage, "parentNow"> | null };

/**
 * The pair gate, in the order docs/FORKS.md's "Who may see one" gives:
 *
 * 1. both sides parse, or the answer is not-found;
 * 2. each doc is read by id alone, so a slug is not-found, and a deleted one
 *    is refused by hand, since canUserReadDoc doesn't consider deletion;
 * 3. if either side is unreadable, so is the whole pair, and a title
 *    answers the same way rather than naming half a pair;
 * 4. **a version needs canUserSeeDocVersion, asked before the version itself
 *    is looked for**, so a reader without the history gets forbidden whatever
 *    the id;
 * 5. then a version that isn't in its doc's log is not-found, never replaced
 *    by the doc as it is now. In the other order, forbidden against not-found
 *    would tell that reader which ids are in the log.
 *
 * The same doc on both sides is allowed: nothing opens a Y.Doc in the
 * browser. Each side arrives as Next hands the segment over, to a page and
 * to a Route Handler alike (`@` as `%40`), and `parseDiffSide` decodes it.
 */
export async function gateDiffPair(user: Session["user"], left: string, right: string): Promise<GatedPair | "not-found" | "forbidden"> {
  const leftSide = parseDiffSide(left);
  const rightSide = parseDiffSide(right);
  if (leftSide === null || rightSide === null) return "not-found";
  const sides = [leftSide, rightSide] as const;

  const [leftDoc, rightDoc] = await Promise.all(
    sides.map((side) => prismaIncludingDeleted.doc.findUnique({ where: { id: side.docId }, select: DOC_SELECT })),
  );
  if (!leftDoc || leftDoc.deletedByUserId !== null || !rightDoc || rightDoc.deletedByUserId !== null) return "not-found";

  const readable = await Promise.all([leftDoc, rightDoc].map((doc) => canUserReadDoc(user.id, user.role, doc)));
  if (!readable.every(Boolean)) return "forbidden";

  const versioned = sides.filter((side): side is DiffSide & { updateId: bigint } => side.updateId !== null);
  const visible = await Promise.all(versioned.map((side) => canUserSeeDocVersion(user.id, user.role, side.docId, side.updateId)));
  if (!visible.every(Boolean)) return "forbidden";
  const inLog = await Promise.all(versioned.map((side) => isDocVersion(side.docId, side.updateId)));
  if (!inLog.every(Boolean)) return "not-found";

  // Whether the viewer may see each side's history, asked of a side with no
  // version too. It decides three things: whether the side has a slider,
  // whether the doc's own reading view would honour `?at=` for this viewer,
  // and whether the update a side with no version was read at is sent.
  // **canUserSeeDocHistory, never canUserSeeDocVersion**: a version may also
  // be visible as a fork's first state, to a viewer the parent's scrub bar
  // and index are not for.
  const [leftHistory, rightHistory] = await Promise.all(
    sides.map((side) => canUserSeeDocHistory(user.id, user.role, side.docId)),
  );
  return {
    left: { side: leftSide, doc: leftDoc, history: leftHistory },
    right: { side: rightSide, doc: rightDoc, history: rightHistory },
    lineage: leftDoc.id === rightDoc.id ? null : pairLineage(leftDoc, rightDoc),
  };
}

type LoadedSide =
  | {
      ok: true;
      title: string;
      blocks: DiffBlock[];
      at: Date | null;
      /** The update a side with no version was read at; null for a side at a version, which names its own. */
      nowVersion: bigint | null;
    }
  /** The store was unavailable, or the ydoc didn't decode under the doc schema. */
  | { ok: false };

/**
 * A side's text and its title as of that side. No version is
 * `loadDocStateNow`, the stored row with the log's later rows applied; a
 * version is `loadDocStateAt`, one replay. Neither comes from `prose_json`,
 * which trails the log while someone types.
 *
 * Either read can throw, once the gate has passed: the side then says so in
 * its place, and the answer is not a 500.
 */
async function loadSide({ side, doc }: GatedSide): Promise<LoadedSide> {
  try {
    const [now, at, row] = await Promise.all([
      side.updateId === null ? loadDocStateNow(doc.id) : null,
      side.updateId === null ? null : loadDocStateAt(doc.id, side.updateId),
      side.updateId === null ? null : prisma.ydocUpdate.findUnique({ where: { id: side.updateId }, select: { createdAt: true } }),
    ]);
    const state = (now ?? at)!;
    return {
      ok: true,
      title: docTitleOrFallback(state.title),
      blocks: state.blocks.map((block) => ({ text: block.text, type: block.node.type.name, heading: block.heading !== null })),
      at: row?.createdAt ?? null,
      nowVersion: now?.version ?? null,
    };
  } catch (err) {
    console.error(`[diff] couldn't read doc ${doc.id}${side.updateId === null ? "" : ` at ${side.updateId}`}:`, err);
    return { ok: false };
  }
}

/**
 * Both sides of a pair `gateDiffPair` let through, as the one shape the page
 * and the route hand the browser.
 *
 * **`nowVersion` leaves here only for a side with `history`.** It is the id
 * of the log's newest update; sent for every side, it would tell a reader
 * without the history that id. The parent's own (`parentNow`) decides the
 * pair's order and stays on the server: only `order` and `diverged` leave.
 */
export async function readDiffPair({ left, right, lineage }: GatedPair): Promise<DiffPairRead> {
  const readAt = new Date();
  const [leftLoaded, rightLoaded] = await Promise.all([loadSide(left), loadSide(right)]);
  // A fork and its parent: where the parent's side stands against the fork
  // point decides whether the pair has an order. A parent's side with no
  // version stands at the update it was just read at.
  const parentLoaded = lineage?.parentDocId === left.doc.id ? leftLoaded : rightLoaded;
  const withNow = lineage && { ...lineage, parentNow: parentLoaded.ok ? parentLoaded.nowVersion : null };
  const sideRead = ({ side, doc, history }: GatedSide, loaded: LoadedSide): DiffSideRead => ({
    docId: doc.id,
    updateId: side.updateId?.toString() ?? null,
    slug: doc.slug,
    title: loaded.ok ? loaded.title : docTitleOrFallback(doc.title),
    history,
    at: loaded.ok ? (loaded.at?.toISOString() ?? null) : null,
    nowVersion: history && loaded.ok ? (loaded.nowVersion?.toString() ?? null) : null,
    blocks: loaded.ok ? loaded.blocks : null,
  });
  return {
    readAt: readAt.toISOString(),
    order: sideOrder(left.side, right.side, withNow),
    diverged: pastForkPoint(left.side, right.side, withNow),
    left: sideRead(left, leftLoaded),
    right: sideRead(right, rightLoaded),
  };
}
