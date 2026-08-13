import * as Y from "yjs";
import { ydocStore } from "../../server/ydoc-store";

// PLAN.md §13q — turning "the version I was looking at" into a `ydoc_update.id`.
//
// A client can name its own version exactly and for free, locally: a Yjs
// **snapshot** (`Y.snapshot` → `Y.encodeSnapshot`) is a few bytes pairing a
// state vector with a delete set. What it cannot be is the *stamp* —
// `Annotation.ydocUpdateId` has to be a monotonic scalar, because the scrubber
// seeks by slider position and "which of these two annotations came first" has
// to be answerable. So the snapshot is the input, the row id is the storage,
// and this is the conversion.
//
// **A bare state vector is not enough, and that is not obvious.** A state
// vector summarises insertions only — deletions advance no peer's clock — so
// two documents differing by a deletion have byte-identical state vectors.
// Measured on a real corpus: 9.5% of all `ydoc_update` rows carry no structs
// at all (pure deletions), in runs of up to 22 consecutive rows, so a vector
// alone leaves the answer ambiguous across a whole run. `Y.snapshot` is Yjs's
// own answer to this and carries the delete set alongside; `dsCoveredBy` below
// is what makes the walk exact through such a run.
//
// The alternative was for the collab server to broadcast the current
// `ydoc_update.id` after every append (Hocuspocus has `broadcastStateless` for
// exactly this) and let clients stamp whatever they last heard. Rejected on
// cost: that is one extra message per Yjs update — permanently, on the busiest
// path there is — to serve an event that happens a handful of times a day. This
// direction puts all of its cost at post time instead, where it is rare, and
// adds nothing to the append path.
//
// A snapshot is also strictly more expressive than a row id: it correctly
// describes an editor whose own just-typed characters have not round-tripped
// yet, which no row id can name. The coverage tests below are what make that
// safe — such a client resolves to the newest row it *has* seen.

/**
 * The clocks a single logged update carries, per peer.
 *
 * **Not `Y.encodeStateVectorFromUpdate`**, which is the obvious call and is
 * wrong here: it answers "what state vector would a document built from this
 * update alone have", and a *delta* update's structs cannot integrate
 * standalone — their predecessors aren't in it — so it returns an empty vector
 * for every row after the first. Measured on a real 1353-update log: 1350 of
 * them came back empty, which made the walk below silently accept any prefix
 * and resolve completely different states to the same id.
 *
 * Reading the struct headers directly is what that function is mistaken for.
 * A struct is `{id: {client, clock}, length}`, so the peer's frontier after
 * this update is `clock + length`, exactly.
 */
function updateClocks(update: Uint8Array): { clocks: Map<number, number>; ds: DeleteRanges } {
  const decoded = Y.decodeUpdate(update);
  const clocks = new Map<number, number>();
  for (const struct of decoded.structs) {
    const end = struct.id.clock + struct.length;
    if ((clocks.get(struct.id.client) ?? 0) < end) clocks.set(struct.id.client, end);
  }
  return { clocks, ds: decoded.ds.clients as DeleteRanges };
}

/** Does `subset` name a version at or before `superset`, for every peer? */
function coveredBy(subset: Map<number, number>, superset: Map<number, number>): boolean {
  for (const [client, clock] of subset) {
    if ((superset.get(client) ?? 0) < clock) return false;
  }
  return true;
}

type DeleteRanges = Map<number, { clock: number; len: number }[]>;

/** Has the client already seen every deletion in `subset`? */
function dsCoveredBy(subset: DeleteRanges, superset: DeleteRanges): boolean {
  for (const [client, ranges] of subset) {
    const seen = superset.get(client);
    for (const range of ranges) {
      // Yjs keeps a client's ranges sorted and non-overlapping, but a range
      // this update introduces can legitimately have been *merged* into a wider
      // one on the client (two adjacent deletions coalesce), so containment is
      // the test rather than equality.
      const contained = seen?.some((r) => r.clock <= range.clock && r.clock + r.len >= range.clock + range.len);
      if (!contained) return false;
    }
  }
  return true;
}

function mergeInto(target: Map<number, number>, source: Map<number, number>): void {
  for (const [client, clock] of source) {
    if ((target.get(client) ?? 0) < clock) target.set(client, clock);
  }
}

export type VersionResolution = {
  /** The newest update the client's version covers, or null if it covers none. */
  updateId: bigint | null;
  /** How many `ydoc_update` rows the walk read. Zero on the head fast path. */
  walked: number;
  /** How the answer was reached — reported so a caller can decide to checkpoint. */
  via: "head" | "walk";
  /**
   * How many pure-deletion rows sit at the end of the resolved prefix.
   *
   * Non-zero means the answer is the *newest* row consistent with the client's
   * vector, but the previous `n` rows are equally consistent — deletions carry
   * no structs, so they advance no clock and a state vector cannot see them.
   * Callers that need to know whether the reader saw a deletion have to
   * disambiguate some other way; callers that only need a document state
   * differing by tombstones can ignore it.
   */
  ambiguousDeleteOnlyRows: number;
};

/**
 * The newest `ydoc_update.id` for `ydocId` whose cumulative state is covered by
 * `clientStateVector` — i.e. the latest row the client had definitely applied.
 *
 * Exact, always. There is deliberately no bail-out to "just use the tail": an
 * approximate stamp would silently break the one thing the stamp is for, and
 * unlike the offsets (which `captureAnnotationAnchor` re-derives against
 * whatever it stamps, so they stay self-consistent either way) there is nothing
 * downstream that would notice. When the walk is long the caller checkpoints so
 * the *next* one is short — see `postAnnotation`. Paying once is the answer, not
 * approximating.
 *
 * Throws only if the store is unavailable; a malformed vector is the caller's
 * to reject before calling.
 */
export async function resolveUpdateIdForSnapshot(
  ydocId: string,
  clientSnapshot: Uint8Array,
  /**
   * The document at the log's tail, if the caller already has it — it does, in
   * `postAnnotation`'s case, and materialising it twice for the head check
   * would be the only real cost this function adds in the common case.
   */
  headDoc?: Y.Doc,
): Promise<VersionResolution> {
  const decoded = Y.decodeSnapshot(clientSnapshot);
  const client = decoded.sv;
  const clientDs = decoded.ds.clients as DeleteRanges;
  const tail = await ydocStore.maxUpdateId(ydocId);
  if (tail === null) return { updateId: null, walked: 0, via: "head", ambiguousDeleteOnlyRows: 0 };

  // Fast path, and the overwhelmingly common one: nobody edited between the
  // reader loading the document and annotating it, so their version is the
  // head's. Free when the caller supplies headDoc, which it does.
  if (headDoc) {
    const head = Y.decodeSnapshot(Y.encodeSnapshot(Y.snapshot(headDoc)));
    if (coveredBy(head.sv, client) && dsCoveredBy(head.ds.clients as DeleteRanges, clientDs)) {
      return { updateId: tail, walked: 0, via: "head", ambiguousDeleteOnlyRows: 0 };
    }
  }

  // Where to start walking from. Cheapest usable base first — all three are
  // vector comparisons rather than replays, because `ydoc.state_vector` and
  // `ydoc_snapshot.state_vector` are stored beside the update ids they
  // correspond to (§11b's invariant 2, and §13q for the `ydoc` row).
  //
  //  1. **The `ydoc` row itself** — a rolling checkpoint written by the store
  //     debounce, so never more than one debounce behind head. This is the
  //     usual answer, and it is what keeps the walk bounded by *seconds of
  //     editing* rather than by the document's lifetime.
  //  2. **A `ydoc_snapshot`** — for a client genuinely behind that checkpoint
  //     (frozen for a long time, a slow link, a scrub).
  //  3. **Nothing** — walk from row #1. Correct, just the expensive case.
  const base =
    (await ydocStore.findCheckpointCoveredBy(ydocId, client)) ??
    (await ydocStore.findNewestSnapshotCoveredBy(ydocId, client));
  const cumulative = base ? Y.decodeStateVector(base.stateVector) : new Map<number, number>();
  let answer: bigint | null = base?.lastYdocUpdateId ?? null;

  // Forward from there, one row at a time. Only the struct *headers* are read
  // (`updateClocks`), never applied — so this is far cheaper than the replay the
  // caller does next, and its cost is in rows read rather than document size.
  // Measured on the largest real document to hand (1353 updates, no snapshot):
  // 15ms to walk 1219 rows.
  const rows = await ydocStore.updatesAfter(ydocId, base?.lastYdocUpdateId ?? null);
  let walked = 0;
  let deleteOnlyRun = 0;
  for (const row of rows) {
    walked++;
    const { clocks, ds } = updateClocks(row.update);
    // Merge first, then test: an update can carry structs from several peers,
    // and the row is only "covered" if the client has all of them. The delete
    // set is tested directly rather than accumulated — a deletion the client
    // hasn't seen is disqualifying on its own, and this is what keeps a run of
    // pure-deletion rows from collapsing into one indistinguishable position.
    const next = new Map(cumulative);
    mergeInto(next, clocks);
    if (!coveredBy(next, client)) break;
    if (!dsCoveredBy(ds, clientDs)) break;
    mergeInto(cumulative, clocks);
    answer = row.id;
    // Still reported, because `dsCoveredBy` closes the ambiguity only when the
    // deletions are actually distinguishable: two rows deleting ranges the
    // client has both seen are still two rows it could have stopped between.
    deleteOnlyRun = clocks.size === 0 ? deleteOnlyRun + 1 : 0;
  }

  return { updateId: answer, walked, via: "walk", ambiguousDeleteOnlyRows: deleteOnlyRun };
}
