import { test } from "node:test";
import assert from "node:assert/strict";
import { isUniqueViolationOn } from "./unique-violation";

// The P2002 shapes isUniqueViolationOn reads: the driver adapter's, measured
// against Postgres 18 through @prisma/adapter-pg 7.9, and the classic
// engine's `meta.target`.

const adapterError = (fields?: unknown) => ({
  code: "P2002",
  meta: {
    modelName: "Doc",
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        kind: "UniqueConstraintViolation",
        ...(fields === undefined ? {} : { constraint: { fields } }),
      },
    },
  },
});

test("the driver adapter's P2002 is read from its constraint's fields", () => {
  assert.equal(isUniqueViolationOn(adapterError(["slug"]), "slug"), true);
  assert.equal(isUniqueViolationOn(adapterError(["doc_id", "user_id"]), "user_id"), true);
  assert.equal(isUniqueViolationOn(adapterError(["id"]), "slug"), false);
});

test("an adapter error whose detail didn't parse names no column", () => {
  assert.equal(isUniqueViolationOn(adapterError(), "slug"), false);
  assert.equal(isUniqueViolationOn({ code: "P2002", meta: { driverAdapterError: {} } }, "slug"), false);
  assert.equal(isUniqueViolationOn({ code: "P2002" }, "slug"), false);
});

test("meta.target is still read, as an array or a string", () => {
  assert.equal(isUniqueViolationOn({ code: "P2002", meta: { target: ["slug"] } }, "slug"), true);
  assert.equal(isUniqueViolationOn({ code: "P2002", meta: { target: "slug" } }, "slug"), true);
  assert.equal(isUniqueViolationOn({ code: "P2002", meta: { target: "doc_slug_key" } }, "slug"), false);
});

test("anything that isn't a P2002 is not a unique violation", () => {
  assert.equal(isUniqueViolationOn({ code: "P2003", meta: { target: ["slug"] } }, "slug"), false);
  assert.equal(isUniqueViolationOn(new Error("slug"), "slug"), false);
  assert.equal(isUniqueViolationOn(null, "slug"), false);
  assert.equal(isUniqueViolationOn(undefined, "slug"), false);
});
