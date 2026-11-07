"use client";

import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { SCHEMA_VERSION } from "./schema-version";
import { parseYdocDbName, ydocDbName } from "./ydoc-db-name";

// Client-side durability for the /ydoc-debug editor only — PostEditor.tsx
// does not use this (PLAN.md §11e). Two distinct duplication bugs, two
// distinct fixes; see the module-level comments below for which is which.

// y-indexeddb's object store of updates, one per key, in the order written.
const UPDATES_STORE = "updates";

type Attachment = { persistence: IndexeddbPersistence; refs: number; doc: Y.Doc };

// Bug 1 (y-indexeddb#25: https://github.com/yjs/y-indexeddb/issues/25) —
// creating more than one IndexeddbPersistence for the same local database
// makes each instance re-persist the updates the *other* instance already
// wrote, because the library's own guard only excludes itself as an origin.
// React StrictMode's double-invoked effects are one way to end up with two
// (same Y.Doc, attached twice) — refcounting fixes that case. Keyed on the
// database *name* rather than the Y.Doc (a WeakMap<Y.Doc> would not catch
// it): two distinct Y.Docs asking to attach the same name — e.g. PLAN.md
// §14c's /side-by-side/<a>/<a>, where two columns would otherwise build two
// separate Y.Docs over the one documentName — hit the exact same bug through
// a path per-doc refcounting can't see. A second attach for a different
// Y.Doc is refused outright rather than silently building a second
// IndexeddbPersistence.
const attachments = new Map<string, Attachment>();

// Bug 2 — the one that actually corrupts content. A stale local IndexedDB
// copy merging into a server document that has been re-seeded (a structurally
// new document, e.g. after a fresh scripts/test-ydoc.ts create reusing an
// id, or any future re-seed path) is the client-side twin of the
// restart-doubling gotcha in docs/YDOC.md, and worse, because IndexedDB survives
// a closed tab. Fixed by keying the local database on the document's
// *lineage* (its `ydoc.created_at`, which only changes when the row is
// recreated) rather than on documentName alone — a re-seed then lands in a
// different local database, so there's nothing to merge.
// `ydocDbName` (ydoc-db-name.ts) builds the name, which also carries the
// bundle's schema version.

/** The updates a y-indexeddb database holds, oldest first. */
async function readUpdates(name: string): Promise<Uint8Array[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains(UPDATES_STORE)) return [];
    return await new Promise<Uint8Array[]>((resolve, reject) => {
      const request = db.transaction(UPDATES_STORE, "readonly").objectStore(UPDATES_STORE).getAll();
      request.onsuccess = () => resolve(request.result as Uint8Array[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

// Settles this document's other local databases, on first attach:
//
//  - another lineage's is deleted, so a stale copy can never be attached
//    later by mistake;
//  - an older schema version's, of this lineage, is taken in and then
//    deleted. It holds what a tab on that bundle typed and hadn't yet synced
//    (while collab restarted for the deploy that brought this bundle, say),
//    and nothing this schema can't build: a newer bundle never writes it;
//  - a newer schema version's is left alone. This bundle can't build what it
//    holds, and the build that can is the one a roll-forward brings back.
//
// The delete waits on any tab that still has the database open, and what such
// a tab writes after this read is lost with it. A refused tab has stopped
// writing (it detaches at the refusal); only a tab from before the gate
// existed keeps typing.
//
// Best-effort: without indexedDB.databases() nothing is listed, so nothing is
// taken in or swept, and the databases sit unused.
async function settleOtherDatabases(doc: Y.Doc, documentName: string, lineageMs: number, current: string, stillAttached: () => boolean): Promise<void> {
  if (typeof indexedDB.databases !== "function") return;
  try {
    for (const { name } of await indexedDB.databases()) {
      if (!name || name === current) continue;
      const parsed = parseYdocDbName(name, documentName);
      if (!parsed) continue;
      if (parsed.lineageMs !== lineageMs) {
        indexedDB.deleteDatabase(name);
        continue;
      }
      if (parsed.version > SCHEMA_VERSION) continue;
      const updates = await readUpdates(name);
      // Applied with no origin of y-indexeddb's own, so the attached
      // persistence stores them and the provider syncs them.
      if (!stillAttached()) return;
      doc.transact(() => {
        for (const update of updates) Y.applyUpdate(doc, update);
      });
      indexedDB.deleteDatabase(name);
    }
  } catch {
    // Best-effort only — never block attaching over this.
  }
}

/**
 * Attaches (or reuses) IndexedDB persistence for `doc`, keyed by the
 * document's lineage and this bundle's schema version. Ref-counted per Y.Doc
 * instance (bug 1); on first attach, sweeps stale lineages for the same
 * documentName (bug 2) and takes in an older schema version's database. Call
 * `detach()` in the same effect's cleanup that calls this.
 */
export function attachIndexeddb(doc: Y.Doc, documentName: string, lineageMs: number): () => void {
  const name = ydocDbName(documentName, lineageMs);
  const existing = attachments.get(name);
  if (existing) {
    if (existing.doc !== doc) {
      console.error(
        `attachIndexeddb: refusing a second attach for "${name}" — a different Y.Doc is already attached. ` +
          "Two Y.Docs sharing one local database would each re-persist the other's writes (y-indexeddb#25).",
      );
      return () => {};
    }
    existing.refs += 1;
    return () => detach(name);
  }

  const persistence = new IndexeddbPersistence(name, doc);
  attachments.set(name, { persistence, refs: 1, doc });
  void settleOtherDatabases(doc, documentName, lineageMs, name, () => attachments.get(name)?.persistence === persistence);

  return () => detach(name);
}

function detach(name: string): void {
  const attachment = attachments.get(name);
  if (!attachment) return;
  attachment.refs -= 1;
  if (attachment.refs <= 0) {
    attachments.delete(name);
    void attachment.persistence.destroy();
  }
}
