import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@/generated/prisma/client";
import { derivePostStatus, publishedPostWhere, readablePostWhere } from "./post-status";

// PLAN.md §20l. `readablePostWhere` is the one place "which posts may this
// viewer see" is written, and two callers depend on it agreeing with itself:
// the gate that lets a tag land on a draft (canUserTagTarget) and the page
// that lists what was tagged (/tag/[slug]). Both hand it straight to Prisma,
// so what is worth asserting is the *shape* of the clause — which is exactly
// the kind of table CLAUDE.md points at test:unit rather than at a browser.
//
// The invariant under every widening: a clause that does not narrow to
// published must carry the byline restriction, or a stranger's draft travels
// with it.

// `publishedPostWhere()` closes over `new Date()`, so two calls are never
// deep-equal — the clause is checked by shape rather than against a captured
// copy. That is the reason this helper exists rather than a PUBLISHED constant.
function assertPublishedOnly(where: Prisma.PostWhereInput, label: string) {
  assert.deepEqual(Object.keys(where).sort(), ["publishEventId", "publishedAt"], label);
  assert.deepEqual(where.publishEventId, { not: null }, label);
  const lte = (where.publishedAt as { lte: Date }).lte;
  assert.ok(lte instanceof Date, `${label}: publishedAt.lte is a Date`);
  assert.ok(Math.abs(lte.getTime() - Date.now()) < 5_000, `${label}: publishedAt.lte is "now"`);
}

test("a signed-out viewer gets the public predicate, nothing else", () => {
  assertPublishedOnly(readablePostWhere(null, null), "signed out");
  // A role with no id, or an id with no role, is a half-read session and must
  // not be treated as either half being enough.
  assertPublishedOnly(readablePostWhere(null, "ADMIN"), "role without an id");
  assertPublishedOnly(readablePostWhere("u1", null), "id without a role");
});

test("ADMIN and EDITOR see every post, so the clause adds nothing", () => {
  assert.deepEqual(readablePostWhere("u1", "ADMIN"), {});
  assert.deepEqual(readablePostWhere("u1", "EDITOR"), {});
});

test("an AUTHOR additionally sees the posts they are on the byline of", () => {
  const where = readablePostWhere("u1", "AUTHOR");
  assert.deepEqual(Object.keys(where), ["OR"]);
  const [published, own] = where.OR as Prisma.PostWhereInput[];
  assertPublishedOnly(published, "AUTHOR's public branch");
  assert.deepEqual(own, { authors: { some: { userId: "u1" } } });
});

test("AUTHORIZED and COMMENTER see published posts only", () => {
  // A byline survives a demotion; the permission doesn't — the same narrowing
  // canUserEditPost makes, restated here because Prisma can't share a boolean
  // predicate with a where clause.
  assertPublishedOnly(readablePostWhere("u1", "AUTHORIZED"), "AUTHORIZED");
  assertPublishedOnly(readablePostWhere("u1", "COMMENTER"), "COMMENTER");
});

test("nothing but ADMIN/EDITOR ever gets an unrestricted clause", () => {
  for (const role of ["AUTHOR", "AUTHORIZED", "COMMENTER"] as const) {
    const where = readablePostWhere("u1", role);
    assert.notDeepEqual(where, {}, `${role} must not get an unrestricted clause`);
    const branches = (where.OR as Prisma.PostWhereInput[] | undefined) ?? [where];
    for (const branch of branches) {
      const restricted = branch.publishEventId !== undefined || branch.authors !== undefined;
      assert.ok(restricted, `${role}: every branch must narrow to published or to the byline`);
    }
  }
});

test("derivePostStatus is what decides a row has no public URL", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  assert.equal(derivePostStatus({ publishEventId: null, publishedAt: null }), "draft");
  assert.equal(derivePostStatus({ publishEventId: "e1", publishedAt: future }), "scheduled");
  assert.equal(derivePostStatus({ publishEventId: "e1", publishedAt: past }), "published");
});

test("publishedPostWhere is evaluated per call, not captured once", () => {
  // Load-bearing: a module-level constant would freeze "now" at import and a
  // long-lived server would stop noticing scheduled posts going live.
  const first = publishedPostWhere().publishedAt as { lte: Date };
  const second = publishedPostWhere().publishedAt as { lte: Date };
  assert.ok(second.lte.getTime() >= first.lte.getTime());
  assert.notEqual(first, second);
});
