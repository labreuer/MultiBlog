import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WEBKIT_POLYFILL_SOURCE } from "./pdfjs-webkit-polyfills";

// The Math.sumPrecise patch, run in a realm of its own with the built-in
// deleted, so the polyfill is what answers whether or not this Node has one.
// The patch is the only thing standing between a Safari below 26.2 and a PDF
// whose TrueType fonts draw as raw character codes (the patch's comment), and
// nothing in the e2e suite can reach the worker realm where that happens.

function patchedSumPrecise(): (items: Iterable<unknown>) => number {
  const context = vm.createContext({ ReadableStream });
  vm.runInContext("delete Math.sumPrecise;", context);
  vm.runInContext(WEBKIT_POLYFILL_SOURCE, context);
  const sum = vm.runInContext("Math.sumPrecise", context);
  assert.equal(typeof sum, "function", "the polyfill should install Math.sumPrecise");
  return sum;
}

// By name, not `instanceof`: the error is the other realm's TypeError.
const isTypeError = (error: unknown) => typeof error === "object" && error !== null && (error as Error).name === "TypeError";

test("Math.sumPrecise sums what pdfjs sums: lengths and widths", () => {
  const sum = patchedSumPrecise();
  assert.equal(sum([6, 12, 24]), 42);
  assert.equal(sum([0.25, 0.5, 0.125]), 0.875);
  assert.equal(sum(new Set([1, 2, 3])), 6, "any iterable, not only arrays");
});

test("Math.sumPrecise does not lose a small term between two large ones", () => {
  const sum = patchedSumPrecise();
  assert.equal(sum([1e20, 0.1, -1e20]), 0.1);
});

test("Math.sumPrecise keeps the proposal's edge cases", () => {
  const sum = patchedSumPrecise();
  assert.ok(Object.is(sum([]), -0), "the empty sum is -0");
  assert.ok(Object.is(sum([-0, -0]), -0));
  assert.ok(Object.is(sum([-0, 0]), 0));
  assert.equal(sum([1, Infinity]), Infinity);
  assert.equal(sum([1, -Infinity]), -Infinity);
  assert.ok(Number.isNaN(sum([Infinity, -Infinity])));
  assert.ok(Number.isNaN(sum([1, NaN])));
  assert.throws(() => sum([1, "2"]), isTypeError);
  assert.throws(() => sum(3 as unknown as Iterable<unknown>), isTypeError);
});
