import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedVisibilities, isSharedOrPublic, newPageVisibilities, sharedOrPublic } from "./doc-visibility";

// docs/WIKI.md "Permissions" — which values each kind of doc may take, and
// for whom: what the visibility selects offer and setDocVisibility accepts.
// PUBLIC is an ADMIN's or EDITOR's to give, and on a person's page its
// owner's alone as well.

const ROLES = ["ADMIN", "EDITOR", "AUTHOR", "AUTHORIZED", "COMMENTER"] as const;
const PUBLISHERS = ["ADMIN", "EDITOR"] as const;
const OTHERS = ["AUTHOR", "AUTHORIZED", "COMMENTER"] as const;
const ALL = ["PRIVATE", "SHARED", "PUBLIC"] as const;

const OWNER = "user-owner";
const OTHER = "user-other";

const plain = { wikiName: null, wikiOwnerUserId: null };
const personal = { wikiName: "Institution", wikiOwnerUserId: OWNER };
const commons = { wikiName: "Institution", wikiOwnerUserId: null };

test("a doc that isn't a wiki page takes PRIVATE and SHARED, whoever asks", () => {
  for (const visibility of ["PRIVATE", "SHARED"] as const) {
    for (const role of ROLES) {
      assert.deepEqual(allowedVisibilities({ ...plain, visibility }, { id: OWNER, role }), ["PRIVATE", "SHARED"]);
    }
    assert.deepEqual(allowedVisibilities({ ...plain, visibility }, null), ["PRIVATE", "SHARED"]);
  }
});

test("a commons page: an ADMIN or EDITOR may set SHARED or PUBLIC, never PRIVATE", () => {
  for (const role of PUBLISHERS) {
    for (const visibility of ["SHARED", "PUBLIC"] as const) {
      assert.deepEqual(allowedVisibilities({ ...commons, visibility }, { id: OTHER, role }), ["SHARED", "PUBLIC"]);
    }
  }
});

test("a commons page: anyone else can't raise it to PUBLIC, and may lower one that is", () => {
  for (const role of OTHERS) {
    assert.deepEqual(allowedVisibilities({ ...commons, visibility: "SHARED" }, { id: OTHER, role }), ["SHARED"]);
    assert.deepEqual(allowedVisibilities({ ...commons, visibility: "PUBLIC" }, { id: OTHER, role }), ["SHARED", "PUBLIC"]);
  }
  assert.deepEqual(allowedVisibilities({ ...commons, visibility: "SHARED" }, null), ["SHARED"]);
  assert.deepEqual(allowedVisibilities({ ...commons, visibility: "PUBLIC" }, null), ["SHARED", "PUBLIC"]);
});

test("a person's page: an owner who is an ADMIN or EDITOR may set any value", () => {
  for (const role of PUBLISHERS) {
    for (const visibility of ALL) {
      assert.deepEqual(allowedVisibilities({ ...personal, visibility }, { id: OWNER, role }), ["PRIVATE", "SHARED", "PUBLIC"]);
    }
  }
});

test("a person's page: an owner who isn't goes as far as SHARED, and may lower a page that is PUBLIC", () => {
  for (const role of OTHERS) {
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "PRIVATE" }, { id: OWNER, role }), ["PRIVATE", "SHARED"]);
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "SHARED" }, { id: OWNER, role }), ["PRIVATE", "SHARED"]);
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "PUBLIC" }, { id: OWNER, role }), ["PRIVATE", "SHARED", "PUBLIC"]);
  }
});

test("a person's page: anyone but its owner only keeps or lowers it, an ADMIN or EDITOR included", () => {
  const viewers = [...ROLES.map((role) => ({ id: OTHER, role })), null];
  for (const viewer of viewers) {
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "PUBLIC" }, viewer), ["PRIVATE", "SHARED", "PUBLIC"]);
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "SHARED" }, viewer), ["PRIVATE", "SHARED"]);
    assert.deepEqual(allowedVisibilities({ ...personal, visibility: "PRIVATE" }, viewer), ["PRIVATE"]);
  }
});

test("a page being made has no value to keep: PUBLIC is an ADMIN's or EDITOR's, in their own namespace and the commons", () => {
  for (const role of PUBLISHERS) {
    assert.deepEqual(newPageVisibilities(OWNER, { id: OWNER, role }), ["PRIVATE", "SHARED", "PUBLIC"]);
    assert.deepEqual(newPageVisibilities(null, { id: OWNER, role }), ["SHARED", "PUBLIC"]);
  }
  for (const role of OTHERS) {
    assert.deepEqual(newPageVisibilities(OWNER, { id: OWNER, role }), ["PRIVATE", "SHARED"]);
    assert.deepEqual(newPageVisibilities(null, { id: OWNER, role }), ["SHARED"]);
  }
});

test("a page being made in someone else's namespace takes nothing, and nor does one made signed out", () => {
  for (const role of ROLES) {
    assert.deepEqual(newPageVisibilities(OWNER, { id: OTHER, role }), []);
  }
  assert.deepEqual(newPageVisibilities(OWNER, null), []);
  assert.deepEqual(newPageVisibilities(null, null), ["SHARED"]);
});

test("the value asked for is never taken for one a page has: no viewer without the role is offered PUBLIC for a new page", () => {
  // What allowedVisibilities would answer if a new page's requested PUBLIC
  // were passed as its visibility, which is why a new page has its own form.
  assert.ok(allowedVisibilities({ ...personal, visibility: "PUBLIC" }, { id: OWNER, role: "AUTHOR" }).includes("PUBLIC"));
  assert.ok(!newPageVisibilities(OWNER, { id: OWNER, role: "AUTHOR" }).includes("PUBLIC"));
  assert.ok(!newPageVisibilities(null, { id: OWNER, role: "AUTHOR" }).includes("PUBLIC"));
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
