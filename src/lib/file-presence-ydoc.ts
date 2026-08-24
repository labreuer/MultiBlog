import * as Y from "yjs";
import { ydocStore, encodeYdocState } from "../../server/ydoc-store";

// PLAN.md §19 Phase 4 — creating a file's presence document if it doesn't
// exist yet.
//
// Server-only (it reaches the ydoc store directly). Split out of the token
// route so the shape is stated once: an *empty* Yjs document, created on
// demand, whose only job is to be something a Hocuspocus connection — and
// therefore an awareness channel — can attach to.
//
// Created on demand rather than at upload: a PDF nobody opens collaboratively
// needs no row, and creating one eagerly would put an empty ydoc beside every
// uploaded file.
//
// `createIfAbsent` handles a concurrent race however it resolves, which is the
// whole reason to use it rather than find-then-create: two readers opening the
// same PDF at the same moment is the normal case, not the rare one.
//
// **No lineage is returned, unlike /api/doc/[id]/token.** Lineage exists to key
// a client's local IndexedDB store so a stale offline copy can never merge into
// a re-seeded document (PLAN.md §11e). This document has no content to persist
// offline, so the viewer attaches no IndexedDB at all — and a lineage nothing
// consumes would just be a value to keep correct for no reason.

const EMPTY_STATE = (() => {
  const doc = new Y.Doc();
  const state = encodeYdocState(doc);
  doc.destroy();
  return state;
})();

export async function ensureFilePresenceYdoc(documentName: string): Promise<void> {
  await ydocStore.createIfAbsent(documentName, EMPTY_STATE.ydoc, EMPTY_STATE.stateVector);
}
