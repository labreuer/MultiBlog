import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_STEP_IN,
  MAX_STEP_OUT,
  clampScaleFactor,
  isNamedScale,
  pinchScaleFactor,
  refitScaleFactor,
  touchDistance,
  touchMidpoint,
  wheelScaleFactor,
} from "./pdf-zoom";

// PLAN.md §19d. Every one of these is a factor rather than a boolean, which is
// the kind of wrong that ships: a gesture that zooms sixteen times too fast
// still zooms, and reads as a bad feel rather than as a bug in a number.

test("scrolling down zooms out, up zooms in", () => {
  assert.ok(wheelScaleFactor(50, 0) < 1);
  assert.ok(wheelScaleFactor(-50, 0) > 1);
});

test("a mouse notch is clamped to one step, not the exponential's answer", () => {
  // exp(-100/200) is about 0.61 — a jump of several zoom levels for one notch.
  assert.equal(wheelScaleFactor(100, 0), MAX_STEP_OUT);
  assert.equal(wheelScaleFactor(-100, 0), MAX_STEP_IN);
  assert.equal(wheelScaleFactor(240, 0), MAX_STEP_OUT);
});

test("a trackpad pinch's small deltas pass through the curve untouched", () => {
  const factor = wheelScaleFactor(2, 0);
  assert.ok(factor > MAX_STEP_OUT && factor < 1, `expected a gentle zoom out, got ${factor}`);
  assert.ok(Math.abs(factor - Math.exp(-0.01)) < 1e-12);
});

test("Firefox's line-mode deltas are converted, not read raw", () => {
  // Three lines is a notch. Read raw it would be exp(-3/200) — a 1.5% nudge
  // where Chrome moves 20%, which reads as the gesture being broken in Firefox.
  assert.equal(wheelScaleFactor(3, 1), MAX_STEP_OUT);
  assert.equal(wheelScaleFactor(1, 2), MAX_STEP_OUT);
  // Small line deltas still land inside the clamp rather than pinning to it.
  assert.ok(wheelScaleFactor(0.25, 1) > MAX_STEP_OUT);
});

test("a zero or nonsense delta changes nothing", () => {
  assert.equal(wheelScaleFactor(0, 0), 1);
  assert.equal(wheelScaleFactor(Number.NaN, 0), 1);
  assert.equal(wheelScaleFactor(Number.POSITIVE_INFINITY, 0), 1);
});

test("a pinch compares against the previous move, and is clamped the same way", () => {
  assert.equal(pinchScaleFactor(100, 110), 1.1);
  assert.equal(pinchScaleFactor(100, 1000), MAX_STEP_IN);
  assert.equal(pinchScaleFactor(100, 1), MAX_STEP_OUT);
});

test("a pinch with no previous distance — the first move of a gesture — is a no-op", () => {
  assert.equal(pinchScaleFactor(0, 120), 1);
  assert.equal(pinchScaleFactor(120, 0), 1);
  assert.equal(pinchScaleFactor(Number.NaN, 120), 1);
});

test("clamping refuses a negative or non-finite factor rather than inverting the zoom", () => {
  assert.equal(clampScaleFactor(-2), 1);
  assert.equal(clampScaleFactor(0), 1);
  assert.equal(clampScaleFactor(Number.NaN), 1);
});

test("distance and midpoint are the plain geometry", () => {
  const a = { clientX: 0, clientY: 0 };
  const b = { clientX: 30, clientY: 40 };
  assert.equal(touchDistance(a, b), 50);
  assert.deepEqual(touchMidpoint(a, b), [15, 20]);
});

test("the named scales are the ones that have to be recomputed on a resize", () => {
  for (const named of ["auto", "page-fit", "page-width", "page-actual"]) {
    assert.ok(isNamedScale(named), named);
  }
  // A number — including the string pdfjs itself stores after a pinch — is a
  // decision the reader made, not a rule to re-evaluate.
  assert.ok(!isNamedScale("1.35"));
  assert.ok(!isNamedScale("1"));
  assert.ok(!isNamedScale(null));
  assert.ok(!isNamedScale(undefined));
  assert.ok(!isNamedScale(""));
});

test("a rotation scales a chosen zoom with the width it has to live in", () => {
  // Landscape to portrait: less width, so the same fraction of the page.
  assert.ok(Math.abs(refitScaleFactor(800, 400) - 0.5) < 1e-12);
  // And back.
  assert.equal(refitScaleFactor(400, 800), 2);
  assert.equal(refitScaleFactor(400, 400), 1);
});

test("a rotation with no width to compare against changes nothing", () => {
  assert.equal(refitScaleFactor(0, 400), 1);
  assert.equal(refitScaleFactor(400, 0), 1);
  assert.equal(refitScaleFactor(Number.NaN, 400), 1);
});

test("the refit factor is deliberately not clamped like a gesture step is", () => {
  // A quarter-turn can halve the width, and that is one legitimate move rather
  // than a runaway gesture — clamping it would leave the page overflowing.
  assert.ok(refitScaleFactor(1000, 390) < MAX_STEP_OUT);
});
