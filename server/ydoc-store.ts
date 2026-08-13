import * as Y from "yjs";
import { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/prisma";

// The only code that touches ydoc / ydoc_update / ydoc_snapshot (PLAN.md
// §11c). Deliberately generic — it takes a documentName and bytes, and knows
// nothing about posts, revisions, or authz, so it stays reusable for any Yjs
// document the app grows later rather than being another post-shaped table.

export type LoadedYdoc = { ydoc: Uint8Array; stateVector: Uint8Array; createdAt: Date };
export const UNAVAILABLE = Symbol("ydoc-store-unavailable");
export type LoadResult = LoadedYdoc | null | typeof UNAVAILABLE;

export type CreateIfAbsentResult =
  | { won: true }
  | { won: false; existing: LoadedYdoc };

// A slice of a document's history sufficient to replay it up to (and
// including) throughUpdateId — PLAN.md §15b. base is the newest snapshot at
// or before throughUpdateId, or null when none qualifies (in which case
// invariant 1, PLAN.md §11b, guarantees updates[0] is itself a full state);
// updates are ordered ids in (baseMark, throughUpdateId].
export type ReplaySlice = {
  base: Uint8Array | null;
  baseSnapshotId: string | null;
  updates: Uint8Array[];
};

// Prisma's foreign-key-violation code — the `ydoc` row was deleted (or never
// existed) underneath a write that assumed it. Same classification as
// server/collab.ts's ignoreMissingPost, generalized to "the store cannot take
// the process down." Two distinct codes reach the same "the row is gone"
// state depending on *how* a caller touches the missing row: inserting a
// ydoc_update/ydoc_snapshot child row against it is a foreign-key violation
// (P2003), but storeState's `ydoc.update()` targets the row by its own
// primary key with no FK involved at all — Prisma's `update`/`delete` throw
// "record not found" (P2025) instead, not P2003, when nothing matches.
const FK_VIOLATION = "P2003";
const RECORD_NOT_FOUND = "P2025";
const UNIQUE_VIOLATION = "P2002";
const MISSING_DOC_CODES = new Set([FK_VIOLATION, RECORD_NOT_FOUND]);

// Prisma error codes that mean "can't reach Postgres right now" rather than
// "this particular write is invalid" — worth a circuit breaker so a down
// database isn't hammered once per keystroke.
const CONNECTION_ERROR_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);

const DB_RETRY_MS = 5_000;

function isConnectionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError && CONNECTION_ERROR_CODES.has(err.code)) return true;
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ECONNREFUSED") return true;
  return false;
}

function isMissingDocError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && MISSING_DOC_CODES.has(err.code);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION;
}

// Per-document circuit breaker: once a connection-class error is seen, every
// method for that document short-circuits to UNAVAILABLE for DB_RETRY_MS
// without hitting Postgres again, rather than retrying (and logging) on every
// single keystroke while the database is down.
const unavailableUntil = new Map<string, number>();

function isCircuitOpen(id: string): boolean {
  const until = unavailableUntil.get(id);
  return until !== undefined && until > Date.now();
}

function tripCircuit(id: string): void {
  unavailableUntil.set(id, Date.now() + DB_RETRY_MS);
}

// Appends must be serialized per document so BIGSERIAL id order always
// matches emission order — concurrent inserts would otherwise let ids
// interleave against causal order and break replay. One promise chain per
// documentName; never cleared, but bounded by however many distinct
// documents are ever loaded in this process's lifetime, which mirrors
// Hocuspocus's own per-document in-memory state.
const appendQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  // Swallow so one failed append doesn't poison the chain for the next one —
  // each call still gets its own rejection via the returned promise.
  appendQueues.set(id, next.catch(() => undefined));
  return next;
}

export interface YdocStore {
  load(id: string): Promise<LoadResult>;
  createIfAbsent(id: string, ydoc: Uint8Array, stateVector: Uint8Array): Promise<CreateIfAbsentResult>;
  appendUpdate(id: string, update: Uint8Array): Promise<void>;
  storeState(id: string, ydoc: Uint8Array, stateVector: Uint8Array): Promise<void>;
  createSnapshot(
    id: string,
    ydoc: Uint8Array,
    stateVector: Uint8Array,
    lastYdocUpdateId: bigint,
    userId: string | null,
  ): Promise<{ id: string }>;
  maxUpdateId(id: string): Promise<bigint | null>;
  findSnapshotAtMark(id: string, mark: bigint): Promise<{ id: string } | null>;
  loadReplaySlice(id: string, throughUpdateId: bigint): Promise<ReplaySlice | typeof UNAVAILABLE>;
  // PLAN.md §13q — the two reads `resolveUpdateIdForStateVector` needs. Kept on
  // the store rather than reaching for prisma directly at the call site, per
  // this file's own rule that it is the only code touching the three tables.
  findNewestSnapshotCoveredBy(
    id: string,
    clientStateVector: Map<number, number>,
  ): Promise<{ id: string; lastYdocUpdateId: bigint; stateVector: Uint8Array } | null>;
  updatesAfter(id: string, afterUpdateId: bigint | null): Promise<{ id: bigint; update: Uint8Array }[]>;
}

class PrismaYdocStore implements YdocStore {
  async load(id: string): Promise<LoadResult> {
    if (isCircuitOpen(id)) return UNAVAILABLE;
    try {
      const row = await prisma.ydoc.findUnique({ where: { id } });
      if (!row) return null;
      return { ydoc: new Uint8Array(row.ydoc), stateVector: new Uint8Array(row.stateVector), createdAt: row.createdAt };
    } catch (err) {
      if (isConnectionError(err)) {
        tripCircuit(id);
        return UNAVAILABLE;
      }
      console.error(`[ydoc-store] load(${id}) failed:`, err);
      return UNAVAILABLE;
    }
  }

  async createIfAbsent(id: string, ydoc: Uint8Array, stateVector: Uint8Array): Promise<CreateIfAbsentResult> {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.ydoc.create({ data: { id, ydoc: Buffer.from(ydoc), stateVector: Buffer.from(stateVector) } });
        // Row #1 of ydoc_update is always a full state (invariant 1, PLAN.md
        // §11b) — established once, here, rather than decided per-keystroke.
        await tx.ydocUpdate.create({ data: { ydocId: id, update: Buffer.from(ydoc) } });
      });
      return { won: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await this.load(id);
        if (existing && existing !== UNAVAILABLE) {
          return { won: false, existing };
        }
        // Lost the race, but a concurrent read couldn't find the winner
        // (extremely narrow transaction-visibility window) — surface as
        // unavailable rather than silently returning a fabricated "won".
        throw new Error(`ydoc-store: createIfAbsent(${id}) lost the race but could not read the winner.`);
      }
      if (isConnectionError(err)) {
        tripCircuit(id);
      }
      throw err;
    }
  }

  async appendUpdate(id: string, update: Uint8Array): Promise<void> {
    if (isCircuitOpen(id)) return;
    await enqueue(id, async () => {
      try {
        await prisma.ydocUpdate.create({ data: { ydocId: id, update: Buffer.from(update) } });
      } catch (err) {
        if (isMissingDocError(err)) {
          console.warn(`[ydoc-store] ${id} no longer exists; dropping its pending update.`);
          return;
        }
        if (isConnectionError(err)) {
          tripCircuit(id);
          return;
        }
        console.error(`[ydoc-store] appendUpdate(${id}) failed:`, err);
      }
    });
  }

  async storeState(id: string, ydoc: Uint8Array, stateVector: Uint8Array): Promise<void> {
    if (isCircuitOpen(id)) return;
    try {
      await prisma.ydoc.update({
        where: { id },
        data: { ydoc: Buffer.from(ydoc), stateVector: Buffer.from(stateVector) },
      });
    } catch (err) {
      if (isMissingDocError(err)) {
        console.warn(`[ydoc-store] ${id} no longer exists; dropping its pending state write.`);
        return;
      }
      if (isConnectionError(err)) {
        tripCircuit(id);
        return;
      }
      console.error(`[ydoc-store] storeState(${id}) failed:`, err);
    }
  }

  async createSnapshot(
    id: string,
    ydoc: Uint8Array,
    stateVector: Uint8Array,
    lastYdocUpdateId: bigint,
    userId: string | null,
  ): Promise<{ id: string }> {
    const row = await prisma.ydocSnapshot.create({
      data: {
        ydocId: id,
        ydoc: Buffer.from(ydoc),
        stateVector: Buffer.from(stateVector),
        lastYdocUpdateId,
        userId,
      },
      select: { id: true },
    });
    return row;
  }

  async maxUpdateId(id: string): Promise<bigint | null> {
    const last = await prisma.ydocUpdate.findFirst({ where: { ydocId: id }, orderBy: { id: "desc" }, select: { id: true } });
    return last?.id ?? null;
  }

  async findSnapshotAtMark(id: string, mark: bigint): Promise<{ id: string } | null> {
    return prisma.ydocSnapshot.findFirst({ where: { ydocId: id, lastYdocUpdateId: mark }, select: { id: true } });
  }

  // Newest-first, testing coverage in JS rather than SQL: a state vector is an
  // opaque blob to Postgres, so "is this snapshot's version covered by that
  // client's" cannot be a WHERE clause. There are only ever a handful of
  // snapshots per document (§11b — they are created deliberately, not per
  // update), so this reads a few rows at worst, and the common case is the
  // first one.
  async findNewestSnapshotCoveredBy(
    id: string,
    clientStateVector: Map<number, number>,
  ): Promise<{ id: string; lastYdocUpdateId: bigint; stateVector: Uint8Array } | null> {
    const snapshots = await prisma.ydocSnapshot.findMany({
      where: { ydocId: id },
      orderBy: { lastYdocUpdateId: "desc" },
      select: { id: true, lastYdocUpdateId: true, stateVector: true },
    });
    for (const snapshot of snapshots) {
      const vector = Y.decodeStateVector(new Uint8Array(snapshot.stateVector));
      let covered = true;
      for (const [client, clock] of vector) {
        if ((clientStateVector.get(client) ?? 0) < clock) {
          covered = false;
          break;
        }
      }
      if (covered) {
        return {
          id: snapshot.id,
          lastYdocUpdateId: snapshot.lastYdocUpdateId,
          stateVector: new Uint8Array(snapshot.stateVector),
        };
      }
    }
    return null;
  }

  async updatesAfter(id: string, afterUpdateId: bigint | null): Promise<{ id: bigint; update: Uint8Array }[]> {
    const rows = await prisma.ydocUpdate.findMany({
      where: { ydocId: id, ...(afterUpdateId === null ? {} : { id: { gt: afterUpdateId } }) },
      orderBy: { id: "asc" },
      select: { id: true, update: true },
    });
    return rows.map((r) => ({ id: r.id, update: new Uint8Array(r.update) }));
  }

  // PLAN.md §15b — the replay-base primitive resolveReplayBase never actually
  // was: newest snapshot at or before throughUpdateId, then updates strictly
  // after its mark up to and including throughUpdateId. With no qualifying
  // snapshot, invariant 1 (PLAN.md §11b) guarantees the very first update row
  // is itself a full state, so starting from row #1 is always correct.
  async loadReplaySlice(id: string, throughUpdateId: bigint): Promise<ReplaySlice | typeof UNAVAILABLE> {
    if (isCircuitOpen(id)) return UNAVAILABLE;
    try {
      const snapshot = await prisma.ydocSnapshot.findFirst({
        where: { ydocId: id, lastYdocUpdateId: { lte: throughUpdateId } },
        orderBy: { lastYdocUpdateId: "desc" },
      });

      const updates = await prisma.ydocUpdate.findMany({
        where: {
          ydocId: id,
          id: { lte: throughUpdateId, ...(snapshot ? { gt: snapshot.lastYdocUpdateId } : {}) },
        },
        orderBy: { id: "asc" },
        select: { update: true },
      });

      return {
        base: snapshot ? new Uint8Array(snapshot.ydoc) : null,
        baseSnapshotId: snapshot?.id ?? null,
        updates: updates.map((u) => new Uint8Array(u.update)),
      };
    } catch (err) {
      if (isConnectionError(err)) {
        tripCircuit(id);
        return UNAVAILABLE;
      }
      console.error(`[ydoc-store] loadReplaySlice(${id}, ${throughUpdateId}) failed:`, err);
      return UNAVAILABLE;
    }
  }
}

// Degraded-mode switch (PLAN.md §11c) — every method a logged no-op, for
// local debugging without a database at all. Distinct from the per-document
// circuit breaker above: this is a deliberate, whole-process opt-out, not a
// reaction to a failure.
class NullYdocStore implements YdocStore {
  private warnedOnce = new Set<string>();

  private warn(id: string, method: string): void {
    if (this.warnedOnce.has(id)) return;
    this.warnedOnce.add(id);
    console.warn(`[ydoc-store] YDOC_PERSISTENCE=off — ${method}(${id}) is a no-op.`);
  }

  async load(id: string): Promise<LoadResult> {
    this.warn(id, "load");
    return UNAVAILABLE;
  }

  async createIfAbsent(id: string): Promise<CreateIfAbsentResult> {
    this.warn(id, "createIfAbsent");
    return { won: true };
  }

  async appendUpdate(id: string): Promise<void> {
    this.warn(id, "appendUpdate");
  }

  async storeState(id: string): Promise<void> {
    this.warn(id, "storeState");
  }

  async createSnapshot(id: string): Promise<{ id: string }> {
    this.warn(id, "createSnapshot");
    throw new Error("Snapshots are unavailable while YDOC_PERSISTENCE=off.");
  }

  async maxUpdateId(id: string): Promise<bigint | null> {
    this.warn(id, "maxUpdateId");
    return null;
  }

  async findSnapshotAtMark(id: string): Promise<{ id: string } | null> {
    this.warn(id, "findSnapshotAtMark");
    return null;
  }

  async findNewestSnapshotCoveredBy(
    id: string,
  ): Promise<{ id: string; lastYdocUpdateId: bigint; stateVector: Uint8Array } | null> {
    this.warn(id, "findNewestSnapshotCoveredBy");
    return null;
  }

  async updatesAfter(id: string): Promise<{ id: bigint; update: Uint8Array }[]> {
    this.warn(id, "updatesAfter");
    return [];
  }

  async loadReplaySlice(id: string): Promise<ReplaySlice | typeof UNAVAILABLE> {
    this.warn(id, "loadReplaySlice");
    return UNAVAILABLE;
  }
}

export const ydocStore: YdocStore =
  process.env.YDOC_PERSISTENCE === "off" ? new NullYdocStore() : new PrismaYdocStore();

// Per-document "did this document ever fail to load" flag, kept independently
// of the store implementation because it has to persist for the document's
// whole in-memory lifetime (PLAN.md §11c) — not just for DB_RETRY_MS — so a
// document that came up unseeded can never later overwrite a real ydoc row
// once the circuit closes again.
const degraded = new Set<string>();

export function markDegraded(id: string): void {
  degraded.add(id);
}

export function isDegraded(id: string): boolean {
  return degraded.has(id);
}

export function clearDegraded(id: string): void {
  degraded.delete(id);
}

export function encodeYdocState(doc: Y.Doc): { ydoc: Uint8Array; stateVector: Uint8Array } {
  return { ydoc: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
}
