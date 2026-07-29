"use client";

import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

// Client-side durability for the /ydoc-debug editor only — PostEditor.tsx
// does not use this (PLAN.md §11e). Two distinct duplication bugs, two
// distinct fixes; see the module-level comments below for which is which.

const DB_PREFIX = "ydoc-debug:";

type Attachment = { persistence: IndexeddbPersistence; refs: number };

// Bug 1 (y-indexeddb#25: https://github.com/yjs/y-indexeddb/issues/25) —
// creating more than one IndexeddbPersistence for the same Y.Doc makes each
// instance re-persist the updates the *other* instance already wrote, because
// the library's own guard only excludes itself as an origin. React
// StrictMode's double-invoked effects are exactly how you'd end up with two.
// Refcounting one instance per doc (rather than one per attach call) is the
// fix: a second attach reuses the first instance instead of constructing a
// competing one, and only the last detach actually tears it down.
const attachments = new WeakMap<Y.Doc, Attachment>();

// Bug 2 — the one that actually corrupts content. A stale local IndexedDB
// copy merging into a server document that has been re-seeded (a structurally
// new document, e.g. after a fresh scripts/test-ydoc.ts create reusing an
// id, or any future re-seed path) is the client-side twin of the
// restart-doubling gotcha in CLAUDE.md, and worse, because IndexedDB survives
// a closed tab. Fixed by keying the local database on the document's
// *lineage* (its `ydoc.created_at`, which only changes when the row is
// recreated) rather than on documentName alone — a re-seed then lands in a
// different local database, so there's nothing to merge.
function dbName(documentName: string, lineageMs: number): string {
  return `${DB_PREFIX}${documentName}:${lineageMs}`;
}

// Deletes any other lineage's local database for this document, so a stale
// copy can never be attached later by mistake — merely orphaned data, not a
// live merge target. Best-effort: Firefox doesn't implement
// indexedDB.databases(), in which case stale entries are simply never swept,
// which is harmless (they just sit unused).
async function sweepStaleLineages(documentName: string, currentDbName: string): Promise<void> {
  if (typeof indexedDB.databases !== "function") return;
  try {
    const databases = await indexedDB.databases();
    const prefix = `${DB_PREFIX}${documentName}:`;
    for (const { name } of databases) {
      if (name && name.startsWith(prefix) && name !== currentDbName) {
        indexedDB.deleteDatabase(name);
      }
    }
  } catch {
    // Best-effort cleanup only — never block attaching over this.
  }
}

/**
 * Attaches (or reuses) IndexedDB persistence for `doc`, keyed by the
 * document's lineage. Ref-counted per Y.Doc instance (bug 1); sweeps stale
 * lineages for the same documentName on first attach (bug 2). Call
 * `detach()` in the same effect's cleanup that calls this.
 */
export function attachIndexeddb(doc: Y.Doc, documentName: string, lineageMs: number): () => void {
  const existing = attachments.get(doc);
  if (existing) {
    existing.refs += 1;
    return () => detach(doc);
  }

  const name = dbName(documentName, lineageMs);
  const persistence = new IndexeddbPersistence(name, doc);
  attachments.set(doc, { persistence, refs: 1 });
  void sweepStaleLineages(documentName, name);

  return () => detach(doc);
}

function detach(doc: Y.Doc): void {
  const attachment = attachments.get(doc);
  if (!attachment) return;
  attachment.refs -= 1;
  if (attachment.refs <= 0) {
    attachments.delete(doc);
    void attachment.persistence.destroy();
  }
}
