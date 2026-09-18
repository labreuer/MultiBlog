import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDIT_GRACE_MS,
  isSilentVersion,
  isVersionQuoted,
  isVisiblyEdited,
  visibleVersions,
  withSupersededAt,
} from "./edit-grace";

// PLAN.md §22b — the silence rule, as a table. It belongs under `npm run
// test:unit` for the reason that file's own header gives: the interesting
// cases are boundaries and combinations (replaced one millisecond either side
// of the window, a quoted version inside it, a chain of edits), and driving a
// browser through a clock offset per case to assert on the presence of one
// word would be absurd.
//
// The rule is also the one part of §22 that is *invisible* in a passing UI:
// the whole point of a silent edit is that nothing shows, so a test that
// asserts "no marker appeared" passes equally well against a rule that never
// shows a marker at all. Here each case names what it expects and why.

const POSTED = new Date("2026-09-16T12:00:00.000Z");
const at = (msAfterPosting: number) => new Date(POSTED.getTime() + msAfterPosting);

const MINUTE = 60_000;

function versions(...rows: { createdAt: Date; quoted?: boolean }[]) {
  return withSupersededAt(
    rows.map((row) => ({ createdAt: row.createdAt, wasQuoted: row.quoted === true })),
    (row) => row.wasQuoted,
  );
}

test("EDIT_GRACE_MS is three minutes", () => {
  assert.equal(EDIT_GRACE_MS, 3 * MINUTE);
});

test("the current version is never silent, however soon it was written", () => {
  const [only] = versions({ createdAt: POSTED });
  assert.equal(only.supersededAt, null);
  assert.equal(isSilentVersion(only, POSTED), false);
});

test("a version replaced inside the window is silent", () => {
  const [first, second] = versions({ createdAt: POSTED }, { createdAt: at(MINUTE) });
  assert.equal(isSilentVersion(first, POSTED), true);
  assert.equal(isSilentVersion(second, POSTED), false);
  assert.equal(isVisiblyEdited([first, second], POSTED), false);
});

test("a version replaced after the window is not silent", () => {
  const [first, second] = versions({ createdAt: POSTED }, { createdAt: at(4 * MINUTE) });
  assert.equal(isSilentVersion(first, POSTED), false);
  assert.equal(isVisiblyEdited([first, second], POSTED), true);
});

test("the boundary is inclusive: replaced exactly at the deadline is still silent", () => {
  const [exactly] = versions({ createdAt: POSTED }, { createdAt: at(EDIT_GRACE_MS) });
  assert.equal(isSilentVersion(exactly, POSTED), true);

  const [oneMsLate] = versions({ createdAt: POSTED }, { createdAt: at(EDIT_GRACE_MS + 1) });
  assert.equal(isSilentVersion(oneMsLate, POSTED), false);
});

test("a quoted version is visible even when it was replaced immediately", () => {
  const [first, second] = versions({ createdAt: POSTED, quoted: true }, { createdAt: at(1) });
  assert.equal(isSilentVersion(first, POSTED), false);
  assert.equal(isVisiblyEdited([first, second], POSTED), true);
});

test("a silent version collapses into the one that superseded it", () => {
  // §22b's worked example: posted at 0:00, edited at 0:01, edited again at
  // 0:10. What a reader sees as "the original" is the 0:01 text, because that
  // is what stood when the window closed — not the 0:00 text nobody had time
  // to read, and not nothing.
  const all = versions({ createdAt: POSTED }, { createdAt: at(MINUTE) }, { createdAt: at(10 * MINUTE) });
  const visible = visibleVersions(all, POSTED);
  assert.deepEqual(
    visible.map((v) => v.createdAt.toISOString()),
    [at(MINUTE).toISOString(), at(10 * MINUTE).toISOString()],
  );
  assert.equal(isVisiblyEdited(all, POSTED), true);
});

test("several edits inside the window collapse to one visible version", () => {
  const all = versions(
    { createdAt: POSTED },
    { createdAt: at(10_000) },
    { createdAt: at(20_000) },
    { createdAt: at(30_000) },
  );
  assert.equal(visibleVersions(all, POSTED).length, 1);
  assert.equal(isVisiblyEdited(all, POSTED), false);
});

test("the window is measured from posting, not from the previous edit", () => {
  // Edits two minutes apart, forever. Measured from the previous edit every
  // one of these would be silent; measured from posting only the first is.
  const all = versions(
    { createdAt: POSTED },
    { createdAt: at(2 * MINUTE) },
    { createdAt: at(4 * MINUTE) },
    { createdAt: at(6 * MINUTE) },
  );
  assert.equal(visibleVersions(all, POSTED).length, 3);
});

test("withSupersededAt pairs each row with its successor and leaves the last open", () => {
  const all = versions({ createdAt: POSTED }, { createdAt: at(MINUTE) }, { createdAt: at(2 * MINUTE) });
  assert.deepEqual(
    all.map((v) => v.supersededAt?.toISOString() ?? null),
    [at(MINUTE).toISOString(), at(2 * MINUTE).toISOString(), null],
  );
});

test("an empty history has nothing visible and is not visibly edited", () => {
  assert.deepEqual(visibleVersions([], POSTED), []);
  assert.equal(isVisiblyEdited([], POSTED), false);
});

// PLAN.md §22e — which version an anchored reply's stamp names, given the
// versions' marks in order. The stamp is the parent's newest mark *at reply
// time*, so it equals a mark on the common path and falls strictly inside a
// span only for a reply made against a body posted before versions existed.

test("a stamp equal to a version's mark names that version", () => {
  const marks = [BigInt(10), BigInt(20), BigInt(30)];
  assert.equal(isVersionQuoted(marks, [BigInt(20)], 1), true);
  assert.equal(isVersionQuoted(marks, [BigInt(20)], 0), false);
  assert.equal(isVersionQuoted(marks, [BigInt(20)], 2), false);
});

test("a stamp inside a span names the version that closed it", () => {
  const marks = [BigInt(10), BigInt(20), BigInt(30)];
  assert.equal(isVersionQuoted(marks, [BigInt(25)], 2), true);
  assert.equal(isVersionQuoted(marks, [BigInt(25)], 1), false);
});

test("the first version owns everything up to and including its mark", () => {
  assert.equal(isVersionQuoted([BigInt(10), BigInt(20)], [BigInt(3)], 0), true);
  assert.equal(isVersionQuoted([BigInt(10), BigInt(20)], [BigInt(10)], 0), true);
  assert.equal(isVersionQuoted([BigInt(10), BigInt(20)], [BigInt(11)], 0), false);
});

test("a stamp past the newest mark names nothing", () => {
  assert.equal(isVersionQuoted([BigInt(10), BigInt(20)], [BigInt(21)], 1), false);
  assert.equal(isVersionQuoted([BigInt(10), BigInt(20)], [BigInt(21)], 0), false);
});

test("no stamps, no versions, or an index out of range is never quoted", () => {
  assert.equal(isVersionQuoted([BigInt(10)], [], 0), false);
  assert.equal(isVersionQuoted([], [BigInt(10)], 0), false);
  assert.equal(isVersionQuoted([BigInt(10)], [BigInt(10)], 1), false);
});

test("a quoted version stays visible inside the window", () => {
  const marks = [BigInt(10), BigInt(20)];
  const rows = withSupersededAt(
    [{ createdAt: POSTED }, { createdAt: at(MINUTE) }],
    (_row, index) => isVersionQuoted(marks, [BigInt(10)], index),
  );
  assert.equal(isVisiblyEdited(rows, POSTED), true);
  assert.equal(visibleVersions(rows, POSTED).length, 2);
});
