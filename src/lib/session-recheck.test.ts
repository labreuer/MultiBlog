import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SESSION_RECHECK_SECONDS, isSessionRecheckDue, sessionRecheckSeconds } from "./session-recheck";

// src/app/sign-in/NOTES.md, "The session reads its account again every five
// minutes" — when a token is due, as a function of its `checkedAt` and the
// time, and what the interval is for each thing the variable can hold.

const NOW = 1_800_000_000;
const INTERVAL = 300;

test("a token is due once the interval has passed since its last check, and not before", () => {
  assert.equal(isSessionRecheckDue(NOW, NOW, INTERVAL), false);
  assert.equal(isSessionRecheckDue(NOW - 1, NOW, INTERVAL), false);
  assert.equal(isSessionRecheckDue(NOW - (INTERVAL - 1), NOW, INTERVAL), false);
  assert.equal(isSessionRecheckDue(NOW - INTERVAL, NOW, INTERVAL), true);
  assert.equal(isSessionRecheckDue(NOW - (INTERVAL + 1), NOW, INTERVAL), true);
  assert.equal(isSessionRecheckDue(NOW - 30 * 24 * 60 * 60, NOW, INTERVAL), true);
});

test("a token that was never checked is due: no checkedAt, or one that isn't a number", () => {
  for (const checkedAt of [undefined, null, "", String(NOW), Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
    assert.equal(isSessionRecheckDue(checkedAt, NOW, INTERVAL), true, `checkedAt ${String(checkedAt)}`);
  }
});

test("a checkedAt ahead of the clock is due, so a clock set back puts no check off", () => {
  assert.equal(isSessionRecheckDue(NOW + 1, NOW, INTERVAL), true);
  assert.equal(isSessionRecheckDue(NOW + 24 * 60 * 60, NOW, INTERVAL), true);
});

test("the interval is the one asked for, whatever it is", () => {
  assert.equal(isSessionRecheckDue(NOW - 2, NOW, 3), false);
  assert.equal(isSessionRecheckDue(NOW - 3, NOW, 3), true);
  assert.equal(isSessionRecheckDue(NOW - 3, NOW, 3600), false);
});

test("SESSION_RECHECK_SECONDS is a positive whole number of seconds, and anything else is the default", () => {
  assert.equal(DEFAULT_SESSION_RECHECK_SECONDS, 300);
  assert.equal(sessionRecheckSeconds("3"), 3);
  assert.equal(sessionRecheckSeconds(" 600 "), 600);
  assert.equal(sessionRecheckSeconds("300"), 300);
  for (const raw of [undefined, "", " ", "0", "-5", "2.5", "5m", "five", "1e3", "0x10", "NaN", "Infinity", "99999999999999999999"]) {
    assert.equal(sessionRecheckSeconds(raw), DEFAULT_SESSION_RECHECK_SECONDS, `raw ${String(raw)}`);
  }
});
