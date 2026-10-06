import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DOC_LINK_TEXT_LENGTH, parseDocLinkEdit, parseDocLinkGroupEdit } from "./doc-link-edit";

// The update actions in src/app/actions/doc-links.ts hand this parse's `data`
// to Prisma's `update`, so its rejection surface is the whole point: nothing
// but the named fields, each a string or null, may reach the query.

test("a link's edit, as the popover sends it, passes through", () => {
  assert.deepEqual(parseDocLinkEdit({ text: "why these two", overrideColor: "#a1b2c3" }), {
    data: { text: "why these two", overrideColor: "#a1b2c3" },
  });
  assert.deepEqual(parseDocLinkEdit({ text: null, overrideColor: null }), {
    data: { text: null, overrideColor: null },
  });
});

test("a group's edit, as the panel sends it, passes through", () => {
  assert.deepEqual(parseDocLinkGroupEdit({ name: "Sources", text: null, overrideColor: "#fff" }), {
    data: { name: "Sources", text: null, overrideColor: "#fff" },
  });
});

test("a field left undefined is left out", () => {
  assert.deepEqual(parseDocLinkEdit({ text: "kept", overrideColor: undefined }), { data: { text: "kept" } });
});

test("a nested write through a relation is refused", () => {
  const promote = { user: { update: { role: "ADMIN" } } };
  assert.deepEqual(parseDocLinkGroupEdit(promote), { error: "Unknown field: user." });
  assert.deepEqual(parseDocLinkEdit(promote), { error: "Unknown field: user." });
  assert.deepEqual(parseDocLinkEdit({ text: "x", doc: { update: { visibility: "SHARED" } } }), {
    error: "Unknown field: doc.",
  });
  assert.deepEqual(parseDocLinkGroupEdit({ links: { updateMany: { where: {}, data: { userId: "u" } } } }), {
    error: "Unknown field: links.",
  });
});

test("a column outside the named fields is refused", () => {
  for (const key of ["userId", "docId", "docLinkGroupId", "deletedAt", "mark", "id"]) {
    assert.deepEqual(parseDocLinkEdit({ [key]: null }), { error: `Unknown field: ${key}.` });
  }
  // A link has no name; only its group does.
  assert.deepEqual(parseDocLinkEdit({ name: "x" }), { error: "Unknown field: name." });
});

test("a named field that isn't a string or null is refused", () => {
  assert.deepEqual(parseDocLinkEdit({ text: { set: "x" } }), { error: "Invalid text." });
  assert.deepEqual(parseDocLinkEdit({ text: 5 }), { error: "Invalid text." });
  assert.deepEqual(parseDocLinkEdit({ overrideColor: ["#fff"] }), { error: "Invalid overrideColor." });
  assert.deepEqual(parseDocLinkGroupEdit({ name: true }), { error: "Invalid name." });
});

test("anything but a plain object is refused", () => {
  for (const input of [null, undefined, "text", 3, [], [{ text: "x" }]]) {
    assert.deepEqual(parseDocLinkEdit(input), { error: "Invalid edit." });
  }
});

test("a color is checked as the creates check it", () => {
  assert.deepEqual(parseDocLinkEdit({ overrideColor: "red" }), { error: "Invalid color." });
  assert.deepEqual(parseDocLinkGroupEdit({ overrideColor: "#fff; background: url(x)" }), { error: "Invalid color." });
});

test("text is capped as the creates cap it", () => {
  const atCap = "x".repeat(MAX_DOC_LINK_TEXT_LENGTH);
  assert.deepEqual(parseDocLinkEdit({ text: atCap }), { data: { text: atCap } });
  assert.deepEqual(parseDocLinkEdit({ text: `${atCap}x` }), { error: "Text is too long." });
});
