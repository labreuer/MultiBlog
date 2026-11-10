"use client";

// docs/CITATIONS.md, "An import survives a reload" — the records of an
// import still to send, kept in IndexedDB under the import's id and the
// user's, with the preview's choices, so a reload or a closed tab can resume
// it. Each batch is dropped once the server has answered it, so nothing kept
// here is in the database yet; and the report is the server's, read from
// the rows its records left, so none is kept here either.
//
// **Every call here can fail, and a failure means "nothing to resume", never
// a broken panel**, as comment-draft-store.ts says of its own: a private
// window or blocked storage makes the accessor itself throw.

const DB_NAME = "multiblog-reference-imports";
const STORE = "imports";
const DB_VERSION = 1;

/** One record as a batch sends it. */
export type PendingRecord = { place: number; sourceKey: string | null; short: string | null; csl: unknown; replace: string | null };

export type PendingImport = {
  /** `${userId} ${importId}`. */
  id: string;
  userId: string;
  importId: string;
  startedAt: number;
  /** How many records the import has, sent or not. */
  total: number;
  /** The batches still to send, oldest first: the first is the one in flight when the page went away. */
  batches: PendingRecord[][];
};

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const idOf = (userId: string, importId: string) => `${userId} ${importId}`;

/** Keeps an import's unsent batches, replacing what was kept for it. */
export async function keepPendingImport(pending: Omit<PendingImport, "id">): Promise<void> {
  await run("readwrite", (store) => store.put({ ...pending, id: idOf(pending.userId, pending.importId) }));
}

/** Drops an import's first batch, once the server has answered it; the import itself once none is left. */
export async function dropAnsweredBatch(userId: string, importId: string): Promise<void> {
  const pending = await run<PendingImport | undefined>("readonly", (store) => store.get(idOf(userId, importId)));
  if (!pending) return;
  const batches = pending.batches.slice(1);
  if (batches.length === 0) await discardPendingImport(userId, importId);
  else await run("readwrite", (store) => store.put({ ...pending, batches }));
}

export async function discardPendingImport(userId: string, importId: string): Promise<void> {
  await run("readwrite", (store) => store.delete(idOf(userId, importId)));
}

/**
 * This user's unfinished import, newest first, if one is younger than
 * `maxAgeMs`; older ones are dropped, since past the server's week a resent
 * record could no longer be told from a new one.
 */
export async function unfinishedImport(userId: string, maxAgeMs: number): Promise<PendingImport | null> {
  const all = (await run<PendingImport[]>("readonly", (store) => store.getAll())) ?? [];
  const mine = all.filter((pending) => pending.userId === userId).sort((a, b) => b.startedAt - a.startedAt);
  for (const stale of mine.filter((pending) => Date.now() - pending.startedAt > maxAgeMs)) await discardPendingImport(stale.userId, stale.importId);
  return mine.find((pending) => Date.now() - pending.startedAt <= maxAgeMs && pending.batches.length > 0) ?? null;
}
