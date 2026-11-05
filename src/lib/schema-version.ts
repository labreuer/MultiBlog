// docs/YDOC.md "A tab whose schema is out of date is refused".
//
// A tab keeps running the JavaScript it loaded, and y-tiptap deletes from the
// shared document whatever that tab's schema can't build: a node type it
// lacks, the whole text of a paragraph carrying a mark it lacks, an attribute
// it lacks from anything it edits. So every collab socket states the schema
// version its bundle was compiled with, and the server refuses any other.
//
// Bump SCHEMA_VERSION with every change to a node, mark or attribute of a
// schema a live editor binds to a ydoc: the doc body, an annotation body, a
// title. `schema-version.test.ts` fingerprints those schemas and fails until
// the new version has an entry in SCHEMA_FINGERPRINTS, so a bump can't be
// forgotten. A bump refuses every tab open at its deploy until it reloads.
//
// Browser-safe and dependency-free: the collab server, the browser bundle and
// the e2e specs that open their own sockets all import it.

// Typed as a number, not as its literal: code that compares it (a spec
// asking what a socket stating no version gets) has to typecheck at every
// value it will ever hold.
export const SCHEMA_VERSION: number = 1;

/**
 * Every version's fingerprint, the newest being the current schemas'. The
 * test's failure prints the line to add. Editing an existing entry instead is
 * for a change that provably alters nothing a tab on that version would
 * build, and is otherwise the mistake the test exists to stop.
 */
export const SCHEMA_FINGERPRINTS: Record<number, string> = {
  0: "2f89f1d93f24c7ae",
  // The `entityChip` node in doc and annotation bodies, and the link mark's
  // `chip` attribute (docs/ENTITY_CHIPS.md, step 1).
  1: "fb2e36e26fcad001",
};

/** The socket URL's query parameter carrying the version. */
export const SCHEMA_PARAM = "schema";

/**
 * The refusal, as the server sends it and the client matches on it to tell
 * this refusal from any other. A sentence rather than a code because surfaces
 * print a refusal's reason verbatim.
 */
export const SCHEMA_REFUSAL = "This page is out of date. Reload it to keep editing.";

/** `url` with this bundle's schema version on it. */
export function withSchemaVersion(url: string, version: number = SCHEMA_VERSION): string {
  const parsed = new URL(url);
  parsed.searchParams.set(SCHEMA_PARAM, String(version));
  return parsed.toString();
}

/**
 * The version a socket's URL states, or null when it states none: a tab whose
 * bundle predates the gate. Anything that isn't a whole number is -1, which
 * matches no version.
 */
export function statedSchemaVersion(parameters: URLSearchParams): number | null {
  const raw = parameters.get(SCHEMA_PARAM);
  if (raw === null) return null;
  return /^\d+$/.test(raw) ? Number(raw) : -1;
}
