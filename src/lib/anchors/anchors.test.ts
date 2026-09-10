import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSelector, parseSelectorKind } from "./selector";
import { parseAnchorTargetKind, targetFromColumns, targetKey, targetToColumns } from "./target";
import type { AnchorTarget } from "./types";

// PLAN.md §20b — the pure half of the shared anchor library, under `npm run
// test:unit`. These are exactly the functions the e2e suite *cannot* usefully
// cover: a rejection surface is a table of inputs, and driving a browser to
// exercise one malformed jsonb blob at a time would be absurd.
//
// Run with `node --import tsx --test`, which needs no dependency the repo
// didn't already have — Node 24 strips types natively and `tsx` is what
// resolves the `@/` alias and the CJS/ESM edges the generated Prisma client
// introduces (the same reason e2e/db.ts spawns its worker under it).

const NO_TARGET = { docId: null, postId: null, fileId: null, targetAnnotationId: null };

test("targetToColumns sets exactly one column per kind", () => {
  const cases: [AnchorTarget, keyof typeof NO_TARGET][] = [
    [{ kind: "doc", id: "d1" }, "docId"],
    [{ kind: "post", id: "p1" }, "postId"],
    [{ kind: "file", id: "f1" }, "fileId"],
    [{ kind: "annotation", id: "a1" }, "targetAnnotationId"],
  ];
  for (const [target, column] of cases) {
    const columns = targetToColumns(target);
    assert.equal(columns[column], target.id, `${target.kind} should populate ${column}`);
    const others = Object.entries(columns).filter(([key]) => key !== column);
    assert.ok(
      others.every(([, value]) => value === null),
      `${target.kind} left more than one column non-null: ${JSON.stringify(columns)}`,
    );
  }
});

test("targetFromColumns round-trips every kind", () => {
  const targets: AnchorTarget[] = [
    { kind: "doc", id: "d1" },
    { kind: "post", id: "p1" },
    { kind: "file", id: "f1" },
    { kind: "annotation", id: "a1" },
  ];
  for (const target of targets) {
    assert.deepEqual(targetFromColumns(targetToColumns(target)), target);
  }
});

// The states the hand-written CHECK makes unreachable in Postgres. Handled
// rather than asserted away, so a row that predates the constraint — or one a
// future migration writes wrongly — degrades instead of throwing somewhere
// far from the cause.
test("targetFromColumns rejects a malformed arc", () => {
  assert.equal(targetFromColumns(NO_TARGET), null, "no column set");
  assert.equal(targetFromColumns({ ...NO_TARGET, docId: "d1", postId: "p1" }), null, "two columns set");
  assert.equal(
    targetFromColumns({ docId: "d", postId: "p", fileId: "f", targetAnnotationId: "a" }),
    null,
    "all four set",
  );
});

test("targetKey distinguishes kinds sharing an id", () => {
  assert.notEqual(targetKey({ kind: "doc", id: "x" }), targetKey({ kind: "post", id: "x" }));
  assert.equal(targetKey({ kind: "file", id: "x" }), targetKey({ kind: "file", id: "x" }));
});

test("parseAnchorTargetKind admits only the four arc members", () => {
  for (const kind of ["doc", "post", "file", "annotation"]) {
    assert.equal(parseAnchorTargetKind(kind), kind);
  }
  for (const bad of ["comment", "Doc", "", null, undefined, 3, {}, ["doc"]]) {
    assert.equal(parseAnchorTargetKind(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// POST_RANGE is the interesting rejection: §20i defers it until part-anchors
// join comment_thread's publish-time remap, and until then a blob claiming it
// must not resolve to *something*.
test("parseSelectorKind admits DOC_RANGE and PDF_TEXT only", () => {
  assert.equal(parseSelectorKind("DOC_RANGE"), "DOC_RANGE");
  assert.equal(parseSelectorKind("PDF_TEXT"), "PDF_TEXT");
  for (const bad of ["POST_RANGE", "doc_range", "", null, undefined, 1]) {
    assert.equal(parseSelectorKind(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

const DOC_RANGE = { v: 1, before: "before ", after: " after", blocks: 1 };

test("parseSelector accepts a well-formed DOC_RANGE blob", () => {
  assert.deepEqual(parseSelector("DOC_RANGE", DOC_RANGE), { kind: "DOC_RANGE", selector: DOC_RANGE });
});

test("parseSelector rejects malformed DOC_RANGE blobs", () => {
  const bad: unknown[] = [
    null,
    "a string",
    42,
    {},
    { ...DOC_RANGE, v: 2 }, // a future version this code can't read
    { ...DOC_RANGE, before: 7 },
    { ...DOC_RANGE, after: null },
    { ...DOC_RANGE, blocks: 0 }, // a range spans at least one textblock
    { ...DOC_RANGE, blocks: 1.5 },
    { ...DOC_RANGE, blocks: "2" },
    { before: "x", after: "y", blocks: 1 }, // no version at all
  ];
  for (const value of bad) {
    assert.equal(parseSelector("DOC_RANGE", value), null, `should reject ${JSON.stringify(value)}`);
  }
});

const PDF_TARGET = {
  pageIndex: 0,
  quads: [[0, 0, 10, 0, 0, 10, 10, 10]],
  quote: { exact: "hello", prefix: "", suffix: "" },
  position: { start: 0, end: 5 },
  textVersion: "6.2.108/1",
};

test("parseSelector delegates PDF_TEXT to parsePdfTarget", () => {
  const parsed = parseSelector("PDF_TEXT", PDF_TARGET);
  assert.equal(parsed?.kind, "PDF_TEXT");
  assert.equal(parsed?.selector.quote.exact, "hello");
  // Reuse, not restatement: docs/PDF.md invariant 3 lives in one place even
  // though a PDF anchor can now sit in two tables.
  assert.equal(parseSelector("PDF_TEXT", { ...PDF_TARGET, quads: [] }), null);
  assert.equal(parseSelector("PDF_TEXT", { ...PDF_TARGET, textVersion: "" }), null);
});

// The kind and the blob are meaningless apart (§20b): a PDF blob read as a
// DOC_RANGE is not a degraded anchor, it is a different thing entirely.
test("parseSelector will not read a blob under the wrong kind", () => {
  assert.equal(parseSelector("DOC_RANGE", PDF_TARGET), null);
  assert.equal(parseSelector("PDF_TEXT", DOC_RANGE), null);
  assert.equal(parseSelector(null, DOC_RANGE), null);
  assert.equal(parseSelector("POST_RANGE", DOC_RANGE), null);
});

// PR 2 — the write side of the DOC_RANGE blob. deriveDocRangeSelector's
// output must round-trip through parseDocRangeSelector (via parseSelector),
// and its edges are position arithmetic: a range at the document's start has
// nothing before it, and a cross-block range counts its blocks.
import { deriveDocRangeSelector } from "./selector";
import { pmDocContentSchema } from "../tiptap-schema";

function docOf(...paragraphs: string[]) {
  return pmDocContentSchema.nodeFromJSON({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    })),
  });
}

test("deriveDocRangeSelector captures context and round-trips through parseSelector", () => {
  const body = "The quick brown fox jumps over the lazy dog near the river bank.";
  const quote = "jumps over";
  const from = body.indexOf(quote) + 1;
  const derived = deriveDocRangeSelector(docOf(body), from, from + quote.length);
  assert.equal(derived.before, "The quick brown fox ");
  assert.equal(derived.after, " the lazy dog near the river bank.");
  assert.equal(derived.blocks, 1);
  assert.deepEqual(parseSelector("DOC_RANGE", derived)?.selector, derived);
});

test("a range at the document's start has empty before-context, not an error", () => {
  const derived = deriveDocRangeSelector(docOf("Short."), 1, 6);
  assert.equal(derived.before, "");
  assert.equal(derived.after, ".");
  assert.equal(derived.blocks, 1);
});

test("context is clamped to ~50 characters on each side", () => {
  const long = "x".repeat(200);
  const derived = deriveDocRangeSelector(docOf(long), 101, 102);
  assert.equal(derived.before.length, 50);
  assert.equal(derived.after.length, 50);
});

test("a cross-block range counts its blocks", () => {
  const doc = docOf("First half here", "second half here");
  // From inside the first paragraph to inside the second.
  const derived = deriveDocRangeSelector(doc, 7, 24);
  assert.equal(derived.blocks, 2);
});
