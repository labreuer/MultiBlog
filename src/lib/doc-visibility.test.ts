import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedVisibilities, isSharedOrPublic, sharedOrPublic } from "./doc-visibility";

// docs/WIKI.md "Permissions" — which values each kind of doc may take, and
// for whom: what the visibility selects offer and setDocVisibility accepts.

const OWNER = "user-owner";
const COAUTHOR = "user-coauthor";
const ADMIN = "user-admin";

const plain = { wikiName: null, wikiOwnerUserId: null };
const personal = { wikiName: "Institution", wikiOwnerUserId: OWNER };
const commons = { wikiName: "Institution", wikiOwnerUserId: null };

test("a doc that isn't a wiki page takes PRIVATE and SHARED, whoever asks", () => {
  for (const visibility of ["PRIVATE", "SHARED"] as const) {
    assert.deepEqual(allowedVisibilities({ ...plain, visibility }, OWNER), ["PRIVATE", "SHARED"]);
    assert.deepEqual(allowedVisibilities({ ...plain, visibility }, null), ["PRIVATE", "SHARED"]);
  }
});

test("a commons page takes SHARED and PUBLIC, never PRIVATE", () => {
  assert.deepEqual(allowedVisibilities({ ...commons, visibility: "SHARED" }, ADMIN), ["SHARED", "PUBLIC"]);
  assert.deepEqual(allowedVisibilities({ ...commons, visibility: "PUBLIC" }, COAUTHOR), ["SHARED", "PUBLIC"]);
});

test("a person's page: its owner may set any value", () => {
  for (const visibility of ["PRIVATE", "SHARED", "PUBLIC"] as const) {
    assert.deepEqual(allowedVisibilities({ ...personal, visibility }, OWNER), ["PRIVATE", "SHARED", "PUBLIC"]);
  }
});

test("a person's page: a co-author or an ADMIN only keeps or lowers it", () => {
  for (const viewer of [COAUTHOR, ADMIN, null]) {
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "PUBLIC" }, viewer), ["PRIVATE", "SHARED", "PUBLIC"]);
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "SHARED" }, viewer), ["PRIVATE", "SHARED"]);
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "PRIVATE" }, viewer), ["PRIVATE"]);
  }
});

test("PUBLIC is SHARED everywhere but the wiki's read rule, in both forms", () => {
  assert.equal(isSharedOrPublic("SHARED"), true);
  assert.equal(isSharedOrPublic("PUBLIC"), true);
  assert.equal(isSharedOrPublic("PRIVATE"), false);
  const filter = sharedOrPublic();
  assert.deepEqual(filter, { in: ["SHARED", "PUBLIC"] });
  filter.in.push("PRIVATE");
  assert.deepEqual(sharedOrPublic(), { in: ["SHARED", "PUBLIC"] });
});
