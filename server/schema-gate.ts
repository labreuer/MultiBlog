import { SCHEMA_REFUSAL, SCHEMA_VERSION, statedSchemaVersion } from "../src/lib/schema-version";

// docs/YDOC.md "A tab whose schema is out of date is refused" — the server
// half. Runs first in `onAuthenticate`, which Hocuspocus runs before any sync
// for the document, so a refused tab receives none of the content its schema
// would delete from.

/**
 * What Hocuspocus's `onAuthenticate` catch reads: it sends the client
 * `error.reason ?? "permission-denied"`, so a plain `Error` reaches the
 * browser as "permission-denied" and can't be told from any other refusal.
 */
export class SchemaRefused extends Error {
  readonly reason = SCHEMA_REFUSAL;
  constructor(stated: number) {
    super(`Schema version ${stated} refused; this server is on ${SCHEMA_VERSION}.`);
  }
}

// One line per socket, not per document on it. Cleared at a bound rather
// than on disconnect: the set is a log dedupe, and a line repeated after a
// thousand sockets is no harm.
const loggedSockets = new Set<string>();
function logOnce(key: string, line: string): void {
  if (loggedSockets.has(key)) return;
  if (loggedSockets.size >= 1000) loggedSockets.clear();
  loggedSockets.add(key);
  console.warn(line);
}

/**
 * Throws `SchemaRefused` unless the socket states this server's schema
 * version. A socket stating none is a tab from before the gate existed and
 * counts as version 0.
 *
 * Both outcomes are logged because the first bump waits on the first line
 * going quiet: a tab from before the gate has no code to detach its
 * IndexedDB, so the bump is safe only once such tabs have stopped connecting.
 */
export function refuseStaleSchema(requestParameters: URLSearchParams, socketId: string, documentName: string): void {
  const stated = statedSchemaVersion(requestParameters);
  if (stated === null) {
    logOnce(`${socketId}:unstated`, `[collab] schema gate: socket ${socketId} states no schema version (a tab from before the gate), opening ${documentName}`);
  }
  const version = stated ?? 0;
  if (version === SCHEMA_VERSION) return;
  logOnce(`${socketId}:refused`, `[collab] schema gate: refused socket ${socketId} on schema ${version} (server is on ${SCHEMA_VERSION}), opening ${documentName}`);
  throw new SchemaRefused(version);
}
