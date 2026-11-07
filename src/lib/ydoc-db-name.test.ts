import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "./schema-version";
import { parseYdocDbName, ydocDbName } from "./ydoc-db-name";

const DOC = "ydoc:doc:cabc123";
const LINEAGE = 1_762_300_000_000;

test("version 0 keeps the name from before versions were in it", () => {
  assert.equal(ydocDbName(DOC, LINEAGE, 0), `ydoc-debug:${DOC}:${LINEAGE}`);
});

test("every later version has a name of its own, and this bundle's is the default", () => {
  assert.equal(ydocDbName(DOC, LINEAGE, 3), `ydoc-debug:s3:${DOC}:${LINEAGE}`);
  assert.equal(ydocDbName(DOC, LINEAGE), ydocDbName(DOC, LINEAGE, SCHEMA_VERSION));
  const names = [0, 1, 2, 10].map((version) => ydocDbName(DOC, LINEAGE, version));
  assert.equal(new Set(names).size, names.length);
});

test("a name parses back to its lineage and version", () => {
  for (const version of [0, 1, 2, 10]) {
    assert.deepEqual(parseYdocDbName(ydocDbName(DOC, LINEAGE, version), DOC), { lineageMs: LINEAGE, version });
  }
});

// What a bundle from before versions were in the name sweeps on attach: every
// database whose name starts with its own minus the lineage. A versioned name
// must not start that way, or that bundle deletes a newer one's database.
test("an unversioned bundle's sweep prefix matches no versioned name", () => {
  const sweepPrefix = `ydoc-debug:${DOC}:`;
  assert.equal(ydocDbName(DOC, LINEAGE, 0).startsWith(sweepPrefix), true);
  assert.equal(ydocDbName(DOC, LINEAGE, 1).startsWith(sweepPrefix), false);
});

test("another document's database is not this one's, whatever its name shares", () => {
  const rejected = [
    // Another document.
    ydocDbName("ydoc:doc:cother", LINEAGE, 1),
    // A document whose name extends this one's.
    ydocDbName(`${DOC}:title`, LINEAGE, 0),
    ydocDbName(`${DOC}:title`, LINEAGE, 2),
    // This document's name as another's prefix, without the separator.
    ydocDbName(`${DOC}9`, LINEAGE, 1),
    // Not a ydoc database at all.
    `comment-drafts`,
    `${DOC}:${LINEAGE}`,
    // No lineage, or one that isn't a number.
    `ydoc-debug:${DOC}`,
    `ydoc-debug:${DOC}:`,
    `ydoc-debug:s1:${DOC}:`,
    `ydoc-debug:s1:${DOC}:12ab`,
    `ydoc-debug:${DOC}:-5`,
    // A version that isn't one.
    `ydoc-debug:s:${DOC}:${LINEAGE}`,
    `ydoc-debug:sx:${DOC}:${LINEAGE}`,
    `ydoc-debug:s1${DOC}:${LINEAGE}`,
  ];
  for (const name of rejected) assert.equal(parseYdocDbName(name, DOC), null, name);
});
