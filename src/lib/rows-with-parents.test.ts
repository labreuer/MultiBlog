import assert from "node:assert/strict";
import { test } from "node:test";
import { rowsWithParents } from "./rows-with-parents";

// docs/DATABASE.md, "A relation is loaded in a statement of its own" — what a
// read hands back when a parent row was hard-deleted between its statements.
// The types below say what Prisma's do: no relation is ever null.

type Comment = { id: string; thread: { post: { title: string } }; commenter: { email: string } };

/** A row as it arrives when a parent is gone: null where the type has none. */
const arrived = (row: { id: string; thread: { post: { title: string } | null } | null; commenter: { email: string } | null }) =>
  row as unknown as Comment;

const whole = arrived({ id: "whole", thread: { post: { title: "A post" } }, commenter: { email: "a@example.com" } });

test("a row whose parents all arrived is kept, in its order", () => {
  const second = { ...whole, id: "second" };
  assert.deepEqual(
    rowsWithParents([whole, second], (row) => [row.thread, row.thread?.post, row.commenter]),
    [whole, second],
  );
});

test("a row is left out when a parent is missing, and when a parent's own parent is", () => {
  const rows = [
    whole,
    arrived({ id: "no-thread", thread: null, commenter: { email: "b@example.com" } }),
    arrived({ id: "no-post", thread: { post: null }, commenter: { email: "c@example.com" } }),
    arrived({ id: "no-commenter", thread: { post: { title: "A post" } }, commenter: null }),
  ];
  assert.deepEqual(
    rowsWithParents(rows, (row) => [row.thread, row.thread?.post, row.commenter]).map((row) => row.id),
    ["whole"],
  );
});

test("an optional relation counts only where its foreign key names a row", () => {
  type Note = { id: string; docId: string | null; doc: { title: string } | null };
  const rows: Note[] = [
    { id: "on-a-doc", docId: "d1", doc: { title: "A doc" } },
    { id: "doc-gone", docId: "d2", doc: null },
    { id: "on-no-doc", docId: null, doc: null },
  ];
  assert.deepEqual(
    rowsWithParents(rows, (row) => (row.docId ? [row.doc] : [])).map((row) => row.id),
    ["on-a-doc", "on-no-doc"],
  );
});
