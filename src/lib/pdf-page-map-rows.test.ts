import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOVED, UNMAPPED, type PageMap, type PageMapRun } from "./pdf-page-map";
import { pageMapRows, pagesOf, rowSheetsOn, sheetRanges, type MapRow, type MapSide } from "./pdf-page-map-rows";

// docs/PDF.md §14, "A version's page map, sheet by sheet" — the maps that
// matter here are ones no fixture PDF produces on demand, so each is written
// out by hand. Sheets in a map are 0-based, and in its rows 1-based.

const NONE: MapSide = { labels: null, withText: null };

function mapOf(sheets: number[], to: number, runs: PageMapRun[] = []): PageMap {
  return { from: sheets.length, to, sheets, runs, blank: { from: [], to: [] } };
}

const run = (start: number, proposed: number[], answer: PageMapRun["answer"] = null, kind: PageMapRun["kind"] = "place"): PageMapRun => ({
  kind,
  start,
  proposed,
  answer,
});

/** Every sheet of the base and of the version in exactly one row. */
function assertEachSheetOnce(map: PageMap, rows: MapRow[]) {
  const base: number[] = [];
  const version: number[] = [];
  for (const row of rows) {
    if (row.kind !== "added") for (let sheet = row.base[0]; sheet <= row.base[1]; sheet++) base.push(sheet);
    if (row.kind === "matched" || row.kind === "added") for (let sheet = row.version[0]; sheet <= row.version[1]; sheet++) version.push(sheet);
    if (row.kind === "run") version.push(...row.version);
  }
  assert.deepEqual(base, Array.from({ length: map.from }, (_, k) => k + 1), "every sheet of the base once, in order");
  assert.deepEqual(
    [...version].sort((a, b) => a - b),
    Array.from({ length: map.to }, (_, k) => k + 1),
    "every sheet of the version once",
  );
}

test("stretches split where the kind or the offset changes, and nowhere else", () => {
  // Base 1 removed; 2 → 1; an added sheet 2; 3–5 → 3–5.
  const map = mapOf([REMOVED, 0, 2, 3, 4], 5);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.kind === "added" ? null : row.base, row.kind === "matched" || row.kind === "added" ? row.version : null]),
    [
      ["removed", [1, 1], null],
      ["matched", [2, 2], [1, 1]],
      ["added", null, [2, 2]],
      ["matched", [3, 5], [3, 5]],
    ],
  );
  assert.equal((rows[1] as Extract<MapRow, { kind: "matched" }>).offset, -1);
  assertEachSheetOnce(map, rows);
});

test("a sheet without text and a pair whose page numbers differ are counted on their row, and split nothing", () => {
  const map = mapOf([0, 1, 2, 3, 4, UNMAPPED, UNMAPPED], 5);
  const base: MapSide = { labels: ["i", "1", "2", "3", "", "5", "6"], withText: new Set([0, 1, 3, 4, 5, 6]) };
  const version: MapSide = { labels: ["i", "1", "x", "3", "", ""], withText: new Set([0, 1, 2, 3, 4]) };
  const rows = pageMapRows(map, base, version);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { kind: "matched", base: [1, 5], version: [1, 5], offset: 0, labelsAgree: 3, labelsDiffer: [3], withoutText: [3] });
  assert.deepEqual(rows[1], { kind: "unmapped", base: [6, 7] });
});

test("where either version has no usable labels, a row says nothing of page numbers; where no text is known, nothing of text", () => {
  const rows = pageMapRows(mapOf([0, 1], 2), { labels: ["1", "2"], withText: null }, { labels: null, withText: null });
  assert.deepEqual(rows[0], { kind: "matched", base: [1, 2], version: [1, 2], offset: 0, labelsAgree: null, labelsDiffer: null, withoutText: null });
  // One side's text known: what is read of it is counted.
  const one = pageMapRows(mapOf([0, 1], 2), { labels: null, withText: new Set([0]) }, NONE);
  assert.deepEqual((one[0] as Extract<MapRow, { kind: "matched" }>).withoutText, [2]);
});

test("a run whose proposed sheets are not consecutive is one row, its sheets listed", () => {
  // Base 2–4 proposed 2, 4, 5 of the version; the version's sheet 3 is added.
  const map = mapOf([0, UNMAPPED, UNMAPPED, UNMAPPED, 5], 6, [run(1, [1, 3, 4])]);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(rows, [
    { kind: "matched", base: [1, 1], version: [1, 1], offset: 0, labelsAgree: null, labelsDiffer: null, withoutText: null },
    { kind: "run", run: 0, base: [2, 4], version: [2, 4, 5] },
    // Follows the row holding the version's sheet 2, the run's.
    { kind: "added", version: [3, 3] },
    { kind: "matched", base: [5, 5], version: [6, 6], offset: 1, labelsAgree: null, labelsDiffer: null, withoutText: null },
  ]);
  assertEachSheetOnce(map, rows);
});

test("a sheet proposed by an open run, or a declined one, is in that run's row and in no added row", () => {
  const declined = { accepted: false, byUserId: "u", at: "2026-11-14T00:00:00.000Z" };
  const map = mapOf([UNMAPPED, 1, UNMAPPED], 3, [run(0, [0]), run(2, [2], declined, "labels")]);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["run", "matched", "run"],
  );
  assertEachSheetOnce(map, rows);
});

test("an accepted run stays one row of its own, apart from the stretches beside it", () => {
  const accepted = { accepted: true, byUserId: "u", at: "2026-11-14T00:00:00.000Z" };
  const map = mapOf([0, 1, 2, 3], 4, [run(1, [1, 2], accepted)]);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(
    rows.map((row) => (row.kind === "added" ? row.kind : [row.kind, row.base])),
    [
      ["matched", [1, 1]],
      ["run", [2, 3]],
      ["matched", [4, 4]],
    ],
  );
  assertEachSheetOnce(map, rows);
});

test("where pairs cross, each added stretch follows the row holding the version's sheet before its first", () => {
  // Labels can pair sheets in any order: base 1–2 → 4–5, base 3–4 → 1–2. The
  // version's sheet 3 follows the row that holds its sheet 2 (base 3–4), and
  // its sheet 6 the row that holds its sheet 5 (base 1–2).
  const map = mapOf([3, 4, 0, 1], 6);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.kind === "added" ? row.version : row.base]),
    [
      ["matched", [1, 2]],
      ["added", [6, 6]],
      ["matched", [3, 4]],
      ["added", [3, 3]],
    ],
  );
  assertEachSheetOnce(map, rows);
});

test("an added stretch that begins at the version's first sheet comes first of all", () => {
  const map = mapOf([2, 3, REMOVED], 5);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.kind === "added" ? row.version : row.base]),
    [
      ["added", [1, 2]],
      ["matched", [1, 2]],
      ["added", [5, 5]],
      ["removed", [3, 3]],
    ],
  );
  assertEachSheetOnce(map, rows);
});

test("two added stretches after one row keep the version's order", () => {
  const map = mapOf([UNMAPPED, UNMAPPED, 4], 6, [run(0, [0, 2])]);
  const rows = pageMapRows(map, NONE, NONE);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.kind === "added" ? row.version : row.base]),
    [
      ["run", [1, 2]],
      ["added", [2, 2]],
      ["added", [4, 4]],
      ["matched", [3, 3]],
      ["added", [6, 6]],
    ],
  );
  assertEachSheetOnce(map, rows);
});

test("an empty map is no rows, and a map onto no sheets is its base's stretches alone", () => {
  assert.deepEqual(pageMapRows(mapOf([], 0), NONE, NONE), []);
  assert.deepEqual(pageMapRows(mapOf([], 2), NONE, NONE), [{ kind: "added", version: [1, 2] }]);
  assert.deepEqual(pageMapRows(mapOf([REMOVED, REMOVED], 0), NONE, NONE), [{ kind: "removed", base: [1, 2] }]);
});

test("sheetRanges joins consecutive numbers and keeps the order given", () => {
  assert.deepEqual(sheetRanges([2, 3, 4, 7, 9, 10]), [
    [2, 4],
    [7, 7],
    [9, 10],
  ]);
  assert.deepEqual(sheetRanges([5, 4]), [
    [5, 5],
    [4, 4],
  ]);
});

test("pagesOf names the printed pages of a row's sheets from the first and last that have one", () => {
  const labels = ["", "ii", "iii", "", "1", "3"];
  assert.equal(pagesOf(labels, [1, 2, 3]), "pp. ii–iii");
  assert.equal(pagesOf(labels, [5]), "p. 1");
  assert.equal(pagesOf(labels, [1, 4]), null);
  assert.equal(pagesOf(labels, [4, 5, 6]), "pp. 1–3");
  // In the order given, as a run's proposed sheets are.
  assert.equal(pagesOf(labels, [6, 5]), "pp. 3–1");
  // A label twice over is one page.
  assert.equal(pagesOf(["x", "x"], [1, 2]), "p. x");
  assert.equal(pagesOf(null, [1]), null);
});

test("rowSheetsOn lists a row's sheets on each side", () => {
  const run: MapRow = { kind: "run", run: 0, base: [2, 3], version: [5, 2] };
  assert.deepEqual(rowSheetsOn(run, "base"), [2, 3]);
  assert.deepEqual(rowSheetsOn(run, "version"), [5, 2]);
  assert.deepEqual(rowSheetsOn({ kind: "added", version: [4, 5] }, "base"), []);
  assert.deepEqual(rowSheetsOn({ kind: "removed", base: [1, 1] }, "version"), []);
});
