import * as Y from "yjs";

// A ydoc's update log as a browser holds it, and one Y.Doc moved along it: the
// replay under /ydoc-debug's slider, the doc page's scrub bar and the post
// page's (`useReplayScrub`, src/components/YdocDebug.tsx), and under the diff
// page's sliders (src/lib/doc-version.worker.ts). One place for the part that
// is easy to get wrong: forward is the only way a Y.Doc can be advanced, so
// anything else is a rebuild from the newest snapshot at or before the target
// (PLAN.md §11f, §11h).
//
// Browser-safe, and imports Yjs alone: it runs in a worker.

/** The body of `GET /api/ydoc/[id]/replay` and of `GET /api/doc/[id]/replay`. */
export type ReplayPayload = {
  updates: { id: string; createdAt: string; base64: string }[];
  snapshots: { id: string; createdAt: string; lastYdocUpdateId: string; base64: string }[];
};

export type PreparedUpdate = { id: bigint; createdAt: string; bytes: Uint8Array };
export type PreparedSnapshot = {
  id: string;
  createdAt: string;
  lastYdocUpdateId: bigint;
  bytes: Uint8Array;
  /** Index in `updates` this snapshot sits at, for placing its dot. */
  sliderIndex: number;
};
export type PreparedReplay = { updates: PreparedUpdate[]; snapshots: PreparedSnapshot[] };

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// base64 → bytes once, up front, so a timed seek measures Yjs replay and
// nothing else. Base64 is a transport artifact of shipping this over JSON; a
// real reader would fetch binary, so folding its cost into the per-scrub
// measurement would overstate what replay actually costs.
export function prepareReplay(replay: ReplayPayload): PreparedReplay {
  const updates: PreparedUpdate[] = replay.updates.map((u) => ({
    id: BigInt(u.id),
    createdAt: u.createdAt,
    bytes: base64ToBytes(u.base64),
  }));

  const snapshots: PreparedSnapshot[] = replay.snapshots.map((s) => {
    const mark = BigInt(s.lastYdocUpdateId);
    // The update this snapshot's high-water mark names. Falls back to the
    // last update at or below the mark if that exact row is somehow gone.
    let sliderIndex = updates.findIndex((u) => u.id === mark);
    if (sliderIndex === -1) {
      sliderIndex = updates.reduce((acc, u, i) => (u.id <= mark ? i : acc), 0);
    }
    return { id: s.id, createdAt: s.createdAt, lastYdocUpdateId: mark, bytes: base64ToBytes(s.base64), sliderIndex };
  });

  return { updates, snapshots };
}

/**
 * The newest snapshot at or before `index`, plus the first update index that
 * still has to be applied on top of it. With no qualifying snapshot the base
 * is update row #1, which invariant 1 (PLAN.md §11b) guarantees is a full
 * state — so replaying from index 0 is always self-sufficient.
 */
function baseFor(prepared: PreparedReplay, index: number): { snapshot: PreparedSnapshot | null; startIndex: number } {
  const targetId = prepared.updates[index].id;

  let snapshot: PreparedSnapshot | null = null;
  for (const candidate of prepared.snapshots) {
    // Ascending by lastYdocUpdateId, so the last one that still qualifies wins.
    if (candidate.lastYdocUpdateId <= targetId) snapshot = candidate;
    else break;
  }
  if (!snapshot) return { snapshot: null, startIndex: 0 };

  const mark = snapshot.lastYdocUpdateId;
  const startIndex = prepared.updates.findIndex((u) => u.id > mark);
  // -1 means the snapshot already covers every update we have; nothing to
  // apply on top of it.
  return { snapshot, startIndex: startIndex === -1 ? prepared.updates.length : startIndex };
}

/** One seek: the doc at the target, and how it got there. */
export type ReplaySeek = {
  /** The cursor's own doc, at the target. **Not the caller's to destroy**, and moved by the next seek. */
  doc: Y.Doc;
  /** `forward`: the doc in hand was advanced. `rebuild`: a new one was built from its base. */
  mode: "forward" | "rebuild";
  /** The snapshot the doc is built on; null when its base is update row #1. */
  snapshot: PreparedSnapshot | null;
  /** The first update applied on top of that base. */
  startIndex: number;
  /** How many updates this seek applied. */
  applied: number;
  /** The time the replay itself took, in milliseconds. */
  elapsedMs: number;
};

/**
 * One Y.Doc moved along a prepared log. Forward from the doc already in hand
 * is the only incremental path Yjs allows. It's unavailable going backward,
 * and also when a *newer* snapshot now covers the target — in which case
 * rebuilding from that snapshot is both correct and cheaper than replaying the
 * deltas between here and there. That second case is the only way a snapshot
 * ever earns its keep on a forward jump.
 */
export class ReplayCursor {
  private doc: Y.Doc | null = null;
  private baseSnapshotId: string | null = null;
  private index = -1;

  constructor(readonly prepared: PreparedReplay) {}

  /**
   * Moves to `index`, which is within the log. Throws when the bytes aren't a
   * valid Yjs update (/ydoc-debug's --garbage fixture), having reset itself
   * so the next seek rebuilds from scratch instead of continuing from a
   * half-applied doc.
   */
  seek(index: number): ReplaySeek {
    const { prepared } = this;
    const required = baseFor(prepared, index);
    const incremental =
      this.doc !== null && index >= this.index && (required.snapshot?.id ?? null) === this.baseSnapshotId;

    let applied = 0;
    try {
      const t0 = performance.now();
      if (incremental) {
        const doc = this.doc!;
        for (let i = this.index + 1; i <= index; i++) {
          Y.applyUpdate(doc, prepared.updates[i].bytes);
          applied++;
        }
      } else {
        const doc = new Y.Doc();
        if (required.snapshot) Y.applyUpdate(doc, required.snapshot.bytes);
        for (let i = required.startIndex; i <= index; i++) {
          Y.applyUpdate(doc, prepared.updates[i].bytes);
          applied++;
        }
        const previous = this.doc;
        this.doc = doc;
        this.baseSnapshotId = required.snapshot?.id ?? null;
        previous?.destroy();
      }
      const elapsedMs = performance.now() - t0;
      this.index = index;
      return {
        doc: this.doc!,
        mode: incremental ? "forward" : "rebuild",
        snapshot: required.snapshot,
        startIndex: required.startIndex,
        applied,
        elapsedMs,
      };
    } catch (err) {
      this.destroy();
      throw err;
    }
  }

  destroy(): void {
    this.doc?.destroy();
    this.doc = null;
    this.baseSnapshotId = null;
    this.index = -1;
  }
}
