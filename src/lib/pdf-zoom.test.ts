import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_STEP_IN,
  MAX_STEP_OUT,
  PINCH_FOLLOW_MS,
  TRACKPAD_PINCH_GAIN,
  WHEEL_TICK_FACTOR,
  clampScaleFactor,
  createTickAccumulator,
  createWheelReader,
  gestureStepFactor,
  isNamedScale,
  pinchScaleFactor,
  readWheel,
  refitScaleFactor,
  tickScaleFactor,
  touchDistance,
  touchMidpoint,
  wheelIsZoom,
  type WheelIntent,
} from "./pdf-zoom";

// PLAN.md §19d. Every one of these is a factor rather than a boolean, which is
// the kind of wrong that ships: a gesture that zooms sixteen times too fast
// still zooms, and reads as a bad feel rather than as a bug in a number.

const wheel = (deltaY: number, deltaMode = 0, deltaX = 0): WheelIntent =>
  readWheel({ deltaMode, deltaX, deltaY });

/** The tick count of an intent that must be one, so a test reads as arithmetic rather than a cast. */
const readTicks = (intent: WheelIntent): number => {
  assert.equal(intent.kind, "ticks");
  return intent.kind === "ticks" ? intent.ticks : Number.NaN;
};

test("ctrl and ⌘ both mean zoom; a bare wheel means scroll", () => {
  assert.ok(wheelIsZoom({ ctrlKey: true, metaKey: false }));
  assert.ok(wheelIsZoom({ ctrlKey: false, metaKey: true }));
  assert.ok(!wheelIsZoom({ ctrlKey: false, metaKey: false }));
});

test("one notch is one tick, whatever the engine and the OS made of it", () => {
  // Chrome on Windows, Chrome on Linux, Chrome on Windows set to six lines
  // per notch, Windows set to scroll by pages, Firefox's three lines, and a
  // Firefox page-mode event: all the same single step.
  for (const event of [wheel(100), wheel(53), wheel(200), wheel(900), wheel(3, 1), wheel(1, 2)]) {
    assert.deepEqual(event, { kind: "ticks", ticks: -1 });
  }
  assert.deepEqual(wheel(-100), { kind: "ticks", ticks: 1 });
  assert.deepEqual(wheel(-3, 1), { kind: "ticks", ticks: 1 });
});

test("a page-mode event is one notch however small Blink made it", () => {
  // Measured 2026-09-15, Chrome 152 on Windows 11 set to "one screen at a
  // time": `deltaMode` 2 with `deltaY` ±0.364 at a dpr of 2.75 and ±0.667 at
  // 1.5 — one page over devicePixelRatio, never 1 (docs/PDF.md §10c). Read as
  // a fraction it took three notches to make a step, and none at all if the
  // reader alternated.
  assert.deepEqual(wheel(0.364, 2), { kind: "ticks", ticks: -1 });
  assert.deepEqual(wheel(-0.364, 2), { kind: "ticks", ticks: 1 });
  assert.deepEqual(wheel(0.667, 2), { kind: "ticks", ticks: -1 });
  assert.deepEqual(wheel(-0.667, 2), { kind: "ticks", ticks: 1 });
  // The same event through the accumulator moves the document on the first
  // notch, and a reversal undoes exactly it rather than banking nothing.
  const accumulate = createTickAccumulator();
  assert.equal(accumulate(readTicks(wheel(-0.364, 2))), 1);
  assert.equal(accumulate(readTicks(wheel(0.364, 2))), -1);
  // A fractional *line* still accumulates — no engine is known to send one.
  assert.deepEqual(wheel(0.364, 1), { kind: "ticks", ticks: -0.364 });
});

test("a tick is pdfjs's own step, in both directions", () => {
  assert.equal(tickScaleFactor(1), WHEEL_TICK_FACTOR);
  assert.ok(Math.abs(tickScaleFactor(-1) - 1 / WHEEL_TICK_FACTOR) < 1e-12);
  assert.ok(Math.abs(tickScaleFactor(2) - WHEEL_TICK_FACTOR ** 2) < 1e-12);
  assert.equal(tickScaleFactor(0), 1);
  assert.equal(tickScaleFactor(Number.NaN), 1);
  // Nowhere near the clamp: the clamp is for the continuous paths.
  assert.ok(tickScaleFactor(1) < MAX_STEP_IN);
  assert.ok(tickScaleFactor(-1) > MAX_STEP_OUT);
});

test("a trackpad pinch's small deltas take the curve, not a step", () => {
  const intent = wheel(2);
  assert.equal(intent.kind, "pinch");
  if (intent.kind !== "pinch") return;
  assert.ok(intent.factor > MAX_STEP_OUT && intent.factor < 1, `expected a gentle zoom out, got ${intent.factor}`);
  // 2 px at WHEEL_SOFTNESS 100 and no gain: exp(-2 / 100), the fingers exactly.
  assert.ok(Math.abs(intent.factor - Math.exp(-0.02)) < 1e-12);
  const zoomIn = wheel(-2);
  assert.ok(zoomIn.kind === "pinch" && zoomIn.factor > 1);
});

test("the trackpad gain scales the pinch branch in log space and nothing else", () => {
  const gained = readWheel({ deltaMode: 0, deltaX: 0, deltaY: 2 }, 2);
  assert.ok(gained.kind === "pinch" && Math.abs(gained.factor - Math.exp(-0.04)) < 1e-12);
  // A notch is a tick whatever the gain; the band between is untouched too.
  assert.deepEqual(readWheel({ deltaMode: 0, deltaX: 0, deltaY: -100 }, 2), { kind: "ticks", ticks: 1 });
  assert.deepEqual(readWheel({ deltaMode: 0, deltaX: 0, deltaY: 15 }, 2), { kind: "ticks", ticks: -0.5 });
  // A nonsense gain is exact tracking, not a frozen zoom.
  const bad = readWheel({ deltaMode: 0, deltaX: 0, deltaY: 2 }, Number.NaN);
  assert.ok(bad.kind === "pinch" && Math.abs(bad.factor - Math.exp(-0.02)) < 1e-12);
  assert.ok(TRACKPAD_PINCH_GAIN > 1, "a gain of 1 would be no gain — make it a deliberate number");
});

test("a Safari gesture step is this frame's cumulative scale against the last, to the gain", () => {
  assert.equal(gestureStepFactor(1, 1.1), 1.1);
  assert.ok(Math.abs(gestureStepFactor(1.1, 1.21) - 1.1) < 1e-12);
  assert.ok(Math.abs(gestureStepFactor(1, 1.1, 2) - 1.21) < 1e-12);
  // Clamped like the other continuous paths, gain included.
  assert.equal(gestureStepFactor(1, 2, 2), MAX_STEP_IN);
  assert.equal(gestureStepFactor(2, 1, 2), MAX_STEP_OUT);
  // The measured tail: a second gesturestart at the old scale, then nothing.
  assert.equal(gestureStepFactor(0.836, 0.836, 2), 1);
  assert.equal(gestureStepFactor(0, 1.2), 1);
  assert.equal(gestureStepFactor(1.2, Number.NaN), 1);
});

test("a small delta with a horizontal component is a ctrl-scroll, not a pinch", () => {
  // A pinch has no deltaX; a two-finger scroll with ctrl held usually does.
  assert.deepEqual(wheel(2, 0, 1), { kind: "ticks", ticks: -2 / 30 });
});

test("the band between pinch and notch is fractional ticks at pdf.js's rate", () => {
  assert.deepEqual(wheel(15), { kind: "ticks", ticks: -0.5 });
  assert.deepEqual(wheel(-30), { kind: "ticks", ticks: 1 });
  assert.deepEqual(wheel(0.25, 1), { kind: "ticks", ticks: -0.25 });
});

test("a large frame inside a pinch is a pinch frame, clamped; the same frame alone is a notch", () => {
  // The quick-pinch shape measured on a MacBook trackpad (docs/PDF.md §10c):
  // Chromium sent +2.1, +15, +72, +12 px at 0, 79, 96, 107 ms. By size the
  // last three are notches; by timing they are the same gesture.
  const read = createWheelReader();
  const frame = (deltaY: number, timeStamp: number, deltaX = 0) => read({ deltaMode: 0, deltaX, deltaY, timeStamp });
  // A notch with no pinch before it is still a notch: nothing has opened.
  assert.deepEqual(frame(72, 0), { kind: "ticks", ticks: -1 });
  const opening = frame(2.1, 1000);
  assert.equal(opening.kind, "pinch");
  const mid = frame(15, 1079);
  assert.ok(mid.kind === "pinch" && Math.abs(mid.factor - Math.exp(-0.15)) < 1e-12, "15 px inside a pinch takes the curve, not half a tick");
  const big = frame(72, 1096);
  assert.ok(big.kind === "pinch" && big.factor === MAX_STEP_OUT, "72 px inside a pinch is a pinch frame at the clamp, not one tick");
  // Each pinch frame extends the window, so a sustained fast pinch never falls out of it.
  assert.equal(frame(12, 1096 + PINCH_FOLLOW_MS - 1).kind, "pinch");
  // A sideways component is still a ctrl-scroll, even mid-pinch.
  assert.deepEqual(frame(15, 1350, 1), { kind: "ticks", ticks: -0.5 });
  // A tick does not extend the window; after it, the same 72 px is a notch again.
  assert.deepEqual(frame(72, 1350 + PINCH_FOLLOW_MS), { kind: "ticks", ticks: -1 });
  // Line and page events are never pinch frames, inside a window or not.
  frame(2, 5000);
  assert.deepEqual(read({ deltaMode: 1, deltaX: 0, deltaY: 3, timeStamp: 5010 }), { kind: "ticks", ticks: -1 });
});

test("the reader passes the gain through and applies it to a continuing frame", () => {
  const read = createWheelReader();
  read({ deltaMode: 0, deltaX: 0, deltaY: -2, timeStamp: 0 }, 2);
  const next = read({ deltaMode: 0, deltaX: 0, deltaY: -8, timeStamp: 20 }, 2);
  // exp(8 × 2 / 100) = 1.174, under the clamp — the gain, not exact tracking.
  assert.ok(next.kind === "pinch" && Math.abs(next.factor - Math.exp(0.16)) < 1e-12);
});

test("deltaMode is read before deltaY — Firefox switches modes on the other order", () => {
  const reads: string[] = [];
  const event = {
    get deltaMode() {
      reads.push("deltaMode");
      return 1;
    },
    get deltaX() {
      reads.push("deltaX");
      return 0;
    },
    get deltaY() {
      reads.push("deltaY");
      return 3;
    },
  };
  readWheel(event);
  assert.equal(reads[0], "deltaMode");
  assert.ok(reads.indexOf("deltaMode") < reads.indexOf("deltaY"));
});

test("a zero or nonsense delta is nothing", () => {
  assert.deepEqual(wheel(0), { kind: "none" });
  assert.deepEqual(wheel(Number.NaN), { kind: "none" });
  assert.deepEqual(wheel(Number.POSITIVE_INFINITY), { kind: "none" });
});

test("the accumulator carries fractions forward and hands back whole ticks", () => {
  const accumulate = createTickAccumulator();
  assert.equal(accumulate(0.4), 0);
  assert.equal(accumulate(0.4), 0);
  assert.equal(accumulate(0.4), 1); // 1.2 → one tick, 0.2 carried
  assert.equal(accumulate(0.8), 1); // 1.0 → one tick, nothing carried
  assert.equal(accumulate(0.5), 0);
});

test("the accumulator drops the carry when the direction reverses", () => {
  const accumulate = createTickAccumulator();
  assert.equal(accumulate(0.7), 0);
  assert.equal(accumulate(-1), -1); // not -0.3 rounded to nothing
  assert.equal(accumulate(-0.6), 0);
  assert.equal(accumulate(-0.6), -1);
});

test("a whole notch through the accumulator is exactly one tick, carry or no carry", () => {
  const accumulate = createTickAccumulator();
  assert.equal(accumulate(0.7), 0);
  assert.equal(accumulate(1), 1); // 1.7 → 1, and the 0.7 stays banked
  assert.equal(accumulate(0.3), 1);
  assert.equal(accumulate(Number.NaN), 0);
  assert.equal(accumulate(0), 0);
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
