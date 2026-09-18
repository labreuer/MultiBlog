"use client";

import type { JSONContent } from "@tiptap/core";
import type { PendingQuoteHint } from "./comment-quote-pending";

// PLAN.md §23g — an unsent comment lives in the browser, in IndexedDB, keyed
// by which composer it belongs to. Not a server-side row: most commenters
// have no account to hang one on, a draft must never enter the moderation
// queue, and a comment has exactly one writer so a CRDT buys nothing. And
// deliberately not y-indexeddb: ydoc-persistence.ts exists to work around two
// real bugs in that library's interaction with Yjs documents, none of which
// applies to a plain JSON value.
//
// **Every call here can fail, and a failure means "no drafts", never a broken
// composer.** IndexedDB is the one browser API a local test never sees fail:
// a private window, cleared site data, and a browser configured to block
// storage can each make the *accessor* throw, not just the request. So every
// function catches everything and resolves to nothing.

const DB_NAME = "multiblog-comment-drafts";
const STORE = "drafts";
const DB_VERSION = 1;

/** Drafts older than this are pruned the next time any composer opens. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type CommentDraftMode = "markdown" | "rich";

export type CommentDraft = {
  key: string;
  mode: CommentDraftMode;
  /** The Markdown source, in markdown mode; "" otherwise. */
  markdown: string;
  /** The editor's JSON, in rich mode; null otherwise. */
  json: JSONContent | null;
  /** PLAN.md §23g — pending quotations ride in the draft, keyed by the placeholder ids the body carries. */
  pending?: PendingQuoteHint[];
  updatedAt: number;
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
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T | null>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    return await run(store);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // Nothing to do; the handle is gone either way.
    }
  }
}

function isDraft(value: unknown): value is CommentDraft {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    (v.mode === "markdown" || v.mode === "rich") &&
    typeof v.markdown === "string" &&
    (v.json === null || (typeof v.json === "object" && v.json !== null)) &&
    (v.pending === undefined || Array.isArray(v.pending)) &&
    typeof v.updatedAt === "number"
  );
}

export async function loadCommentDraft(key: string): Promise<CommentDraft | null> {
  const value = await withStore("readonly", (store) => requestToPromise(store.get(key)));
  return isDraft(value) ? value : null;
}

export async function saveCommentDraft(draft: Omit<CommentDraft, "updatedAt">): Promise<void> {
  await withStore("readwrite", (store) => requestToPromise(store.put({ ...draft, updatedAt: Date.now() })));
}

export async function deleteCommentDraft(key: string): Promise<void> {
  await withStore("readwrite", (store) => requestToPromise(store.delete(key)));
}

/** Removes every draft older than DRAFT_MAX_AGE_MS. Best-effort, like everything here. */
export async function pruneCommentDrafts(now = Date.now()): Promise<void> {
  await withStore("readwrite", async (store) => {
    const all = await requestToPromise(store.getAll());
    if (!Array.isArray(all)) return null;
    for (const value of all) {
      if (isDraft(value) && now - value.updatedAt > DRAFT_MAX_AGE_MS) {
        store.delete(value.key);
      }
    }
    return null;
  });
}
