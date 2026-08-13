import * as Y from "yjs";

// PLAN.md §13q — the browser half of "which version was I looking at".
//
// Separate from ydoc-version.ts, which does the conversion to a
// `ydoc_update.id` and imports the store to do it: that file is server-only,
// and this one is imported by two client hooks, so they cannot be the same
// module without dragging Prisma into the bundle.
//
// **A snapshot, not `Y.encodeStateVector`.** A state vector summarises
// insertions only — deletions advance no peer's clock — so two documents
// differing by a deletion encode identically. `Y.snapshot` pairs the vector
// with the delete set, which is what makes the server-side resolution exact
// through a run of pure-deletion updates. Still tens of bytes.

/**
 * The version of `ydoc` right now, as base64 — BigInt and Uint8Array both
 * survive a server-action boundary badly, and this is small enough that the
 * encoding overhead is irrelevant.
 *
 * **Call this in the same synchronous tick as reading the selection.** The
 * document and the rendered content are in lockstep only until the freeze
 * begins (use-live-doc-content.ts applies remote updates and calls
 * `setContent` in one handler); from the moment a selection exists, updates
 * keep being applied while the render is withheld, so a version taken later
 * describes something the reader was never shown.
 */
export function captureYdocVersion(ydoc: Y.Doc): string {
  return Buffer.from(Y.encodeSnapshot(Y.snapshot(ydoc))).toString("base64");
}
