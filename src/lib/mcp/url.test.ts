import { test } from "node:test";
import assert from "node:assert/strict";
import { isViewerFragment, parseRef } from "./url";

// docs/MCP.md §15 — `read`'s URL parse: every form in the table, absolute or
// as a path, and what it refuses.

const ORIGIN = "https://blog.example.org";

test("doc URLs, by slug or id, with /edit, and a link's ?sel=", () => {
  assert.deepEqual(parseRef("/doc/barfield-notes", ORIGIN), { kind: "doc", param: "barfield-notes", fragment: "" });
  assert.deepEqual(parseRef("/doc/barfield-notes/edit", ORIGIN), { kind: "doc", param: "barfield-notes", fragment: "" });
  assert.deepEqual(parseRef(`${ORIGIN}/doc/x#claude-2026-10-07-14-23-01`, ORIGIN), {
    kind: "doc",
    param: "x",
    fragment: "claude-2026-10-07-14-23-01",
  });
  assert.deepEqual(parseRef("/doc/x?sel=clinkabc", ORIGIN), { kind: "link", id: "clinkabc" });
  assert.deepEqual(parseRef("doc/x", ORIGIN), { kind: "doc", param: "x", fragment: "" });
  // A percent-encoded slug arrives decoded.
  assert.deepEqual(parseRef("/doc/caf%C3%A9", ORIGIN), { kind: "doc", param: "café", fragment: "" });
});

test("PDF URLs keep their fragment, and a fragment link is told from a card's name", () => {
  const page = parseRef("/pdf/saving-appearances#page=12", ORIGIN);
  assert.deepEqual(page, { kind: "pdf", slug: "saving-appearances", fragment: "page=12" });
  const passage = parseRef("/pdf/book#page=3&text=the%20end,of%20it", ORIGIN);
  assert.equal(passage.kind === "pdf" && isViewerFragment(passage.fragment), true);
  assert.equal(isViewerFragment("luke-breuer-2026-10-07-14-23-01"), false);
  assert.deepEqual(parseRef("/pdf/book?sel=clink123", ORIGIN), { kind: "link", id: "clink123" });
});

test("the other reading routes", () => {
  assert.deepEqual(parseRef("/files/report", ORIGIN), { kind: "file", slug: "report" });
  assert.deepEqual(parseRef("/files/report/download", ORIGIN), { kind: "file", slug: "report" });
  assert.deepEqual(parseRef("/annotations", ORIGIN), { kind: "annotations" });
  assert.deepEqual(parseRef("/link/cabc", ORIGIN), { kind: "link", id: "cabc" });
  assert.deepEqual(parseRef("/2026/10/07/a-post#jane-2026-10-07-10-00-00", ORIGIN), {
    kind: "post",
    year: "2026",
    month: "10",
    day: "07",
    slug: "a-post",
    fragment: "jane-2026-10-07-10-00-00",
  });
  assert.deepEqual(parseRef("/post/cpostid/edit", ORIGIN), { kind: "post-id", id: "cpostid", fragment: "" });
  assert.deepEqual(parseRef("/tag/epistemology", ORIGIN), { kind: "tag", slug: "epistemology" });
  assert.deepEqual(parseRef("/authors/luke-breuer", ORIGIN), { kind: "author", slug: "luke-breuer" });
});

test("a bare id, and the URLs another tool answers", () => {
  assert.deepEqual(parseRef("cmgh2k3l40000abcd1234efgh", ORIGIN), { kind: "id", id: "cmgh2k3l40000abcd1234efgh" });
  assert.deepEqual(parseRef("/search?q=x", ORIGIN), { kind: "elsewhere", tool: "search", path: "/search" });
  assert.deepEqual(parseRef("/2026/10", ORIGIN), { kind: "elsewhere", tool: "search", path: "/2026/10" });
});

test("another host, and nonsense, are unknown", () => {
  assert.equal(parseRef("https://elsewhere.example.com/doc/x", ORIGIN).kind, "unknown");
  assert.equal(parseRef("/doc/x", null).kind, "doc");
  assert.equal(parseRef("https://blog.example.org/doc/x", null).kind, "unknown");
  assert.equal(parseRef("/dashboard", ORIGIN).kind, "unknown");
  assert.equal(parseRef("/doc/x/slug", ORIGIN).kind, "unknown");
});
