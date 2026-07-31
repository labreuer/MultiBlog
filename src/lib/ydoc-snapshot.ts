import * as Y from "yjs";
import { ydocStore, UNAVAILABLE, encodeYdocState } from "../../server/ydoc-store";

// PLAN.md §15b — rebuilds a ydoc-stack document's state at an arbitrary past
// ydoc_update.id by replaying its log, the same base-then-deltas shape
// YdocDebug.tsx's useReplayScrub already uses client-side, but as the server-
// side primitive publishing needs. Never destroys nothing it didn't create;
// the caller owns and must destroy the returned Y.Doc.
export async function materializeYdocAt(ydocId: string, throughUpdateId: bigint): Promise<Y.Doc> {
  const slice = await ydocStore.loadReplaySlice(ydocId, throughUpdateId);
  if (slice === UNAVAILABLE) {
    throw new Error("Couldn't read this document's history right now — try again shortly.");
  }

  const doc = new Y.Doc();
  if (slice.base) {
    Y.applyUpdate(doc, slice.base);
  }
  for (const update of slice.updates) {
    Y.applyUpdate(doc, update);
  }
  return doc;
}

// Find-or-create a ydoc_snapshot whose mark is exactly throughUpdateId —
// the "will create a new snapshot / will reuse an existing one" distinction
// PostSnapshotScrubBar surfaces before a publish. Always materializes and
// returns the doc (even when reusing an existing snapshot row) since the
// caller needs its content either way, not just its id.
export async function ensureYdocSnapshotAt(opts: {
  ydocId: string;
  throughUpdateId: bigint;
  userId: string;
}): Promise<{ snapshotId: string; created: boolean; doc: Y.Doc }> {
  const { ydocId, throughUpdateId, userId } = opts;

  const existing = await ydocStore.findSnapshotAtMark(ydocId, throughUpdateId);
  const doc = await materializeYdocAt(ydocId, throughUpdateId);

  if (existing) {
    return { snapshotId: existing.id, created: false, doc };
  }

  const { ydoc, stateVector } = encodeYdocState(doc);
  const snapshot = await ydocStore.createSnapshot(ydocId, ydoc, stateVector, throughUpdateId, userId);
  return { snapshotId: snapshot.id, created: true, doc };
}
