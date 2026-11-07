import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { annotationEditorExtensions, docEditorExtensions, titleEditorExtensions } from "./live-editor-extensions";
import { pmAnnotationContentSchema, pmDocContentSchema, pmTitleSchema } from "./tiptap-schema";
import {
  SCHEMA_FINGERPRINTS,
  SCHEMA_PARAM,
  SCHEMA_VERSION,
  statedSchemaVersion,
  withSchemaVersion,
} from "./schema-version";
import { refuseStaleSchema, SchemaRefused } from "../../server/schema-gate";

// docs/YDOC.md "A tab whose schema is out of date is refused" — the guard
// that makes a SCHEMA_VERSION bump impossible to forget.

// What of a schema decides whether a tab on it can build another tab's
// content: every node and mark by name and in order (a mark's position is its
// rank), each one's attributes with their defaults, and the fields that say
// what may sit where. Nothing about rendering or parsing: `toDOM`, `parseDOM`
// and the like change no stored content.
function describe(schema: Schema): unknown {
  const attrs = (spec: { attrs?: Record<string, { default?: unknown }> }) =>
    Object.entries(spec.attrs ?? {}).map(([name, attr]) => [name, "default" in attr ? { default: attr.default } : "required"]);
  const nodes: unknown[] = [];
  schema.spec.nodes.forEach((name, spec) => {
    nodes.push({
      name,
      content: spec.content ?? null,
      marks: spec.marks ?? null,
      group: spec.group ?? null,
      inline: spec.inline ?? false,
      atom: spec.atom ?? false,
      code: spec.code ?? false,
      attrs: attrs(spec),
    });
  });
  const marks: unknown[] = [];
  schema.spec.marks.forEach((name, spec) => {
    marks.push({
      name,
      excludes: spec.excludes ?? null,
      group: spec.group ?? null,
      inclusive: spec.inclusive ?? true,
      attrs: attrs(spec),
    });
  });
  return { topNode: schema.spec.topNode ?? "doc", nodes, marks };
}

// Never connected: `getSchema` reads each extension's nodes, marks and
// attributes and builds no plugin, which is where a provider would be used.
const provider = null as unknown as HocuspocusProvider;
const user = { id: "u", name: "U", color: "c" };
const getAuthorId = () => "u";

// Each schema a live editor binds to a ydoc, beside the schema everything
// else decodes that ydoc with.
const BOUND = [
  {
    name: "doc body",
    editor: () =>
      getSchema(
        docEditorExtensions({ ydoc: new Y.Doc(), provider, user, renderCaret: () => null as never, getAuthorId, initialAnchors: [] }),
      ),
    decoder: pmDocContentSchema,
  },
  {
    name: "annotation body",
    editor: () => getSchema(annotationEditorExtensions({ ydoc: new Y.Doc(), provider, user, getAuthorId })),
    decoder: pmAnnotationContentSchema,
  },
  {
    name: "title",
    editor: () => getSchema(titleEditorExtensions({ ydoc: new Y.Doc(), getAuthorId })),
    decoder: pmTitleSchema,
  },
];

for (const { name, editor, decoder } of BOUND) {
  test(`the ${name} editor builds the schema its ydoc is decoded with`, () => {
    assert.deepEqual(describe(editor()), describe(decoder));
  });
}

test("the ydoc-bound schemas are the ones SCHEMA_VERSION names", () => {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(BOUND.map(({ name, editor }) => [name, describe(editor())])))
    .digest("hex")
    .slice(0, 16);
  const versions = Object.keys(SCHEMA_FINGERPRINTS).map(Number);
  assert.equal(Math.max(...versions), SCHEMA_VERSION, "SCHEMA_FINGERPRINTS' newest entry is SCHEMA_VERSION's");
  assert.equal(
    SCHEMA_FINGERPRINTS[SCHEMA_VERSION],
    fingerprint,
    `A schema that a live editor binds to a ydoc has changed. A tab still on the old bundle would delete what it ` +
      `can't build, so in src/lib/schema-version.ts set SCHEMA_VERSION = ${SCHEMA_VERSION + 1} and add ` +
      `\`${SCHEMA_VERSION + 1}: "${fingerprint}",\` to SCHEMA_FINGERPRINTS (docs/YDOC.md).`,
  );
});

test("a socket URL carries the version, whatever the URL already holds", () => {
  assert.equal(withSchemaVersion("ws://localhost:1234"), `ws://localhost:1234/?${SCHEMA_PARAM}=${SCHEMA_VERSION}`);
  assert.equal(withSchemaVersion("wss://example.org/collab", 3), `wss://example.org/collab?${SCHEMA_PARAM}=3`);
  assert.equal(withSchemaVersion("wss://example.org/collab?x=1", 3), `wss://example.org/collab?x=1&${SCHEMA_PARAM}=3`);
  assert.equal(withSchemaVersion(`ws://localhost:1234?${SCHEMA_PARAM}=1`, 2), `ws://localhost:1234/?${SCHEMA_PARAM}=2`);
});

test("the version a socket states", () => {
  const stated = (query: string) => statedSchemaVersion(new URLSearchParams(query));
  assert.equal(stated(""), null);
  assert.equal(stated("schema=0"), 0);
  assert.equal(stated("schema=12"), 12);
  for (const junk of ["schema=", "schema=-1", "schema=1.5", "schema=abc", "schema=1e3", "schema=%201"]) {
    assert.equal(stated(junk), -1, junk);
  }
});

test("the gate admits this server's version and refuses every other", (t) => {
  t.mock.method(console, "warn", () => {});
  const gate = (query: string) => refuseStaleSchema(new URLSearchParams(query), "socket", "ydoc:doc:x");
  assert.doesNotThrow(() => gate(`schema=${SCHEMA_VERSION}`));
  for (const query of [`schema=${SCHEMA_VERSION + 1}`, "schema=abc", "schema="]) {
    assert.throws(() => gate(query), SchemaRefused, query);
  }
  // A tab from before the gate states nothing and counts as version 0.
  if (SCHEMA_VERSION === 0) assert.doesNotThrow(() => gate(""));
  else assert.throws(() => gate(""), SchemaRefused);
});

test("a refusal carries the reason Hocuspocus sends the client", () => {
  // `error.reason ?? "permission-denied"` is what the provider is told.
  const refusal: { reason?: unknown } = new SchemaRefused(7);
  assert.equal(typeof refusal.reason, "string");
});
