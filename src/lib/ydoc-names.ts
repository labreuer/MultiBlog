// Naming convention for the standalone ydoc stack (PLAN.md §11a). A document's
// Hocuspocus documentName IS its `ydoc.id` — there is no separate lookup table
// mapping one to the other — so routing a connection to server/ydoc-hooks.ts
// instead of the legacy post_collab path has to be decidable from the name
// alone, with no database round-trip. Post documents are bare cuids; every
// ydoc-stack document is prefixed, which makes that a string check.
//
// Shared between the Next app and the collab server (server/collab.ts,
// server/ydoc-hooks.ts) so the two processes can't drift on what the prefix
// is — the same reason collab-admin.ts shares REPLACE_DOC_PATH.
export const YDOC_PREFIX = "ydoc:";

// Prefix for throwaway documents created by scripts/test-ydoc.ts or the e2e
// suite — mirrors the @example.com containment convention in
// scripts/test-user.ts / e2e/db-worker.ts, so cleanup code can refuse to
// touch anything else by construction.
export const YDOC_TEST_PREFIX = `${YDOC_PREFIX}test-`;

export function isYdocDocument(documentName: string): boolean {
  return documentName.startsWith(YDOC_PREFIX);
}

export function isTestYdocDocument(documentName: string): boolean {
  return documentName.startsWith(YDOC_TEST_PREFIX);
}

export function newYdocId(): string {
  return `${YDOC_PREFIX}${crypto.randomUUID()}`;
}

export function newTestYdocId(): string {
  return `${YDOC_TEST_PREFIX}${crypto.randomUUID()}`;
}

/** Path the collab server's onRequest hook listens on for §11d's snapshot endpoint. */
export const YDOC_SNAPSHOT_PATH = "/admin/ydoc-snapshot";

// PLAN.md §12b — a Doc's documentName is derived from its id, never stored.
// There is no foreign key in either direction between `doc` and `ydoc`: one
// id is a pure function of the other, so the two tables cannot drift, and a
// `ydoc:<cuid>` name with no owning Doc (e.g. every /ydoc-debug document)
// simply isn't a doc's ydoc — docIdFromYdocId only says what doc id a name
// *would* belong to, not that a Doc row with that id exists.
export function ydocIdForDoc(docId: string): string {
  return `${YDOC_PREFIX}${docId}`;
}

export function docIdFromYdocId(ydocId: string): string | null {
  return ydocId.startsWith(YDOC_PREFIX) ? ydocId.slice(YDOC_PREFIX.length) : null;
}

/** Path the collab server's onRequest hook listens on for §12i's annotation-mark endpoint. */
export const ANNOTATION_MARK_PATH = "/admin/annotation-mark";
