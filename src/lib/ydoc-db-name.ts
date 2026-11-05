import { SCHEMA_VERSION } from "./schema-version";

const DB_PREFIX = "ydoc-debug:";

// The name of a ydoc's local IndexedDB database, which ydoc-persistence.ts
// attaches. Pure, so the names are tested without a browser.
//
// The name is keyed on the document's lineage (ydoc-persistence.ts, "Bug 2").
//
// It also carries the bundle's schema version (docs/YDOC.md "The local
// database is named by schema version"), so two bundles never share one. A
// database a newer bundle has written holds content an older bundle's schema
// can't build, and y-tiptap deletes that content from the shared document on
// decoding it; a tab reads its database with no server in between to refuse
// it. Version 0 keeps the name from before versions were in it.
export function ydocDbName(documentName: string, lineageMs: number, version: number = SCHEMA_VERSION): string {
  const scope = version === 0 ? DB_PREFIX : `${DB_PREFIX}s${version}:`;
  return `${scope}${documentName}:${lineageMs}`;
}

/**
 * What a local database's name says of it, for this document: its lineage and
 * the schema version of the bundle that wrote it. Null for any other
 * document's database.
 */
export function parseYdocDbName(name: string, documentName: string): { lineageMs: number; version: number } | null {
  if (!name.startsWith(DB_PREFIX)) return null;
  const rest = name.slice(DB_PREFIX.length);
  // A document name always opens `ydoc:`, so a version's `s<n>:` can't be
  // mistaken for the start of one.
  const versioned = /^s(\d+):/.exec(rest);
  const version = versioned ? Number(versioned[1]) : 0;
  const tail = versioned ? rest.slice(versioned[0].length) : rest;
  if (!tail.startsWith(`${documentName}:`)) return null;
  const lineage = tail.slice(documentName.length + 1);
  return /^\d+$/.test(lineage) ? { lineageMs: Number(lineage), version } : null;
}
