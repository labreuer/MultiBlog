import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REMOVED,
  UNMAPPED,
  answerRun,
  carrySheet,
  counterpartBack,
  counterpartOf,
  mapsJoin,
  pageMapFaults,
  pageMapNumbers,
  parsePageMap,
  type MapVersion,
  type PageMap,
} from "./pdf-page-map";
import { alignInOrder, pairSheets, type SheetFacts, type VersionSheets } from "./pdf-page-map-pairing";
import { RunBook, prepareSheets, preparedAlike, sheetsAlike } from "./pdf-sheet-alike";

// docs/PDF.md §13, "Matching the pages" — the rules that pair a version's
// sheets with its base's, and the map's readers. Each sheet here is made
// text: a seed gives a sheet letters that share no run with another seed's
// but by chance, so "the same sheet" is the same seed and "another sheet" is
// another.

function letters(seed: number, count = 600): string {
  let state = seed * 2654435761 + 1;
  let out = "";
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += String.fromCharCode(97 + ((state >>> 8) % 26));
  }
  return out;
}

const text = (seed: number, label = ""): SheetFacts => ({ skeleton: letters(seed), label, ink: true });
/** A sheet with ink and no text: a plate, or a sheet of an image-only scan. */
const plate = (label = ""): SheetFacts => ({ skeleton: "", label, ink: true });
const blank = (label = ""): SheetFacts => ({ skeleton: "", label, ink: false });
const unlabelled = (...sheets: SheetFacts[]): VersionSheets => ({ sheets, usableLabels: false });
const labelled = (...sheets: SheetFacts[]): VersionSheets => ({ sheets, usableLabels: true });

const by = { userId: "manager", at: new Date("2026-11-14T00:00:00Z") };
const accepted = (map: PageMap, run: number): PageMap => {
  const answer = answerRun(map, run, true, by);
  assert.ok("map" in answer, "refused" in answer ? answer.refused : "");
  return answer.map;
};

test("an alignment is a longest run of pairs in order", () => {
  const align = (a: string, b: string) => [...alignInOrder(a.length, b.length, (i, j) => a[i] === b[j])];
  assert.deepEqual(align("abcd", "abcd"), [0, 1, 2, 3]);
  assert.deepEqual(align("abcd", "bcd"), [-1, 0, 1, 2]);
  assert.deepEqual(align("abcd", "abc"), [0, 1, 2, -1]);
  assert.deepEqual(align("abcd", "axbxcxd"), [0, 2, 4, 6]);
  assert.deepEqual(align("abcd", "wxyz"), [-1, -1, -1, -1]);
  assert.deepEqual(align("", "abc"), []);
  assert.deepEqual(align("abc", ""), [-1, -1, -1]);
  // Six pairs survive the swap of two neighbours and a doubled letter.
  const pairs = align("abcdefgh", "abdcefggh").filter((to) => to >= 0);
  assert.equal(pairs.length, 7);
  assert.deepEqual(pairs, [...pairs].sort((p, q) => p - q));
});

test("two sheets prepared in one book are alike exactly when they are alike", () => {
  const skeletons = [letters(1), letters(1).slice(0, 300) + letters(2, 300), letters(2), "abc", "", letters(3, 20), letters(3, 20).replace(/.$/, "0")];
  const prepared = prepareSheets(skeletons, new RunBook());
  for (let i = 0; i < skeletons.length; i++) {
    for (let j = 0; j < skeletons.length; j++) {
      const inPlace = (index: number) => ({ skeleton: skeletons[index], before: skeletons[index - 1] ?? "", after: skeletons[index + 1] ?? "" });
      assert.equal(preparedAlike(prepared[i], prepared[j]), sheetsAlike(inPlace(i), inPlace(j)), `${i} against ${j}`);
    }
  }
});

test("no labels: the sheets are paired by their text", () => {
  const map = pairSheets(unlabelled(text(1), text(2), text(3)), unlabelled(text(1), text(2), text(3)));
  assert.deepEqual(map.sheets, [0, 1, 2]);
  assert.deepEqual(map.runs, []);
  assert.deepEqual(pageMapNumbers(map), { paired: 3, removed: 0, unmapped: 0, openRuns: 0 });
});

test("a first sheet removed", () => {
  const map = pairSheets(unlabelled(text(1), text(2), text(3), text(4)), unlabelled(text(2), text(3), text(4)));
  assert.deepEqual(map.sheets, [REMOVED, 0, 1, 2]);
});

test("a last sheet removed", () => {
  const map = pairSheets(unlabelled(text(1), text(2), text(3), text(4)), unlabelled(text(1), text(2), text(3)));
  assert.deepEqual(map.sheets, [0, 1, 2, REMOVED]);
});

test("blank sheets added are known insertions", () => {
  const added = pairSheets(unlabelled(text(1), text(2), text(3)), unlabelled(text(1), blank(), text(2), blank(), text(3)));
  assert.deepEqual(added.sheets, [0, 2, 4]);
  // A plate is still placed between its neighbours, the blank sheet beside it taken out of the count.
  const beside = pairSheets(unlabelled(text(1), plate(), text(2)), unlabelled(text(1), blank(), plate(), text(2)));
  assert.deepEqual(beside.sheets, [0, 2, 3]);
  // A blank sheet removed is a known deletion, wherever it stood.
  const removed = pairSheets(unlabelled(text(1), blank(), plate(), text(2)), unlabelled(text(1), plate(), text(2)));
  assert.deepEqual(removed.sheets, [0, REMOVED, 1, 2]);
  // A blank sheet that is still there faces a blank sheet.
  const kept = pairSheets(unlabelled(text(1), blank(), text(2)), unlabelled(text(1), blank(), text(2)));
  assert.deepEqual(kept.sheets, [0, 1, 2]);
});

test("a sheet removed where only an added blank sheet stands is removed, not unmapped", () => {
  const map = pairSheets(unlabelled(text(1), text(2), text(3)), unlabelled(text(1), blank(), text(3)));
  assert.deepEqual(map.sheets, [0, REMOVED, 2]);
});

test("sheets with ink and no text are placed between their aligned neighbours", () => {
  const same = pairSheets(unlabelled(text(1), plate(), plate(), text(2)), unlabelled(text(1), plate(), plate(), text(2)));
  assert.deepEqual(same.sheets, [0, 1, 2, 3]);
  // The run between the neighbours is another length: nothing says which plate is which.
  const fewer = pairSheets(unlabelled(text(1), plate(), plate(), text(2)), unlabelled(text(1), plate(), text(2)));
  assert.deepEqual(fewer.sheets, [0, UNMAPPED, UNMAPPED, 2]);
  assert.deepEqual(fewer.runs, []);
  // An image-only scan and its copy with as many sheets: every sheet by its place.
  const scans = pairSheets(unlabelled(plate(), plate(), plate()), unlabelled(plate(), plate(), plate()));
  assert.deepEqual(scans.sheets, [0, 1, 2]);
  // A sheet that gained its text layer is still the sheet at its place.
  const read = pairSheets(unlabelled(text(1), plate(), text(2)), unlabelled(text(1), text(7), text(2)));
  assert.deepEqual(read.sheets, [0, 1, 2]);
});

test("a label on two sheets maps the first to the first and the second to the second", () => {
  // The body restarts at 1 after front matter numbered 1 too. The two sheets labelled 1 hold the same words, so only their order says which is which.
  const base = labelled(text(1, "1"), text(2, "i"), text(1, "1"), text(3, "2"));
  const map = pairSheets(base, labelled(text(1, "1"), text(2, "i"), text(1, "1"), text(3, "2")));
  assert.deepEqual(map.sheets, [0, 1, 2, 3]);
  assert.deepEqual(map.runs, []);
});

test("a label on two sheets of one version and three of the other says nothing, and the text is taken without a question", () => {
  const base = labelled(text(9, "i"), text(1, "1"), text(2, "1"), text(3, "2"));
  const version = labelled(text(9, "i"), text(8, "1"), text(1, "1"), text(2, "1"), text(3, "2"));
  const map = pairSheets(base, version);
  assert.deepEqual(map.sheets, [0, 2, 3, 4]);
  assert.deepEqual(map.runs, []);
});

test("a label the version lacks sends its sheet to the text", () => {
  const map = pairSheets(labelled(text(1, "i"), text(2, "ii"), text(3, "1")), labelled(text(1, "i"), text(2, "A"), text(3, "1")));
  assert.deepEqual(map.sheets, [0, 1, 2]);
  assert.deepEqual(map.runs, []);
});

test("a sheet whose own label is empty has none to match by", () => {
  const map = pairSheets(labelled(text(1, "i"), text(2, ""), text(3, "1")), labelled(text(1, "i"), text(2, ""), text(3, "1")));
  assert.deepEqual(map.sheets, [0, 1, 2]);
});

// A scan whose labels start one sheet late: printed page 1 is on the second
// sheet and the label "1" on the third. Its better copy has the labels right.
const lateLabels = (...sheets: ((label: string) => SheetFacts)[]) => labelled(...sheets.map((sheet, index) => sheet(["i", "ii", "1", "2", "3", "4"][index])));
const rightLabels = (...sheets: ((label: string) => SheetFacts)[]) => labelled(...sheets.map((sheet, index) => sheet(["i", "1", "2", "3", "4", "5"][index])));
const page = (seed: number) => (label: string) => text(seed, label);

test("labels corrected: neither answer is taken, and the alignment's is one question", () => {
  const sheets = [page(1), page(2), page(3), page(4), page(5), page(6)];
  const map = pairSheets(lateLabels(...sheets), rightLabels(...sheets));
  // "i" agrees with its text. "ii" is a label the version lacks, so its text is taken. The rest disagree.
  assert.deepEqual(map.sheets, [0, 1, UNMAPPED, UNMAPPED, UNMAPPED, UNMAPPED]);
  assert.deepEqual(map.runs, [{ kind: "labels", start: 2, proposed: [2, 3, 4, 5], byLabel: [1, 2, 3, 4], answer: null }]);
  assert.equal(pageMapNumbers(map).openRuns, 1);
  assert.equal(counterpartOf(map.sheets, 3), null);

  const after = accepted(map, 0);
  assert.deepEqual(after.sheets, [0, 1, 2, 3, 4, 5]);
  assert.equal(pageMapNumbers(after).openRuns, 0);
  assert.equal(counterpartOf(after.sheets, 3), 3);
  // Accepted, it stays.
  assert.ok("refused" in answerRun(after, 0, false, by));
  assert.ok("refused" in answerRun(after, 0, true, by));
});

test("a declined run leaves its sheets unmapped, and may still be accepted", () => {
  const sheets = [page(1), page(2), page(3), page(4), page(5), page(6)];
  const map = pairSheets(lateLabels(...sheets), rightLabels(...sheets));
  const declined = answerRun(map, 0, false, by);
  assert.ok("map" in declined);
  assert.deepEqual(declined.map.sheets, map.sheets);
  assert.equal(pageMapNumbers(declined.map).openRuns, 0);
  assert.deepEqual(accepted(declined.map, 0).sheets, [0, 1, 2, 3, 4, 5]);
  assert.ok("refused" in answerRun(map, 3, true, by));
});

test("a sheet without text inside the corrected stretch joins the run", () => {
  const sheets = [page(1), page(2), page(3), (label: string) => plate(label), page(5), page(6)];
  const map = pairSheets(lateLabels(...sheets), rightLabels(...sheets));
  // The plate's label gives it the sheet before, as its neighbours' do; they lost theirs, so it is proposed its place.
  assert.deepEqual(map.runs, [{ kind: "labels", start: 2, proposed: [2, 3, 4, 5], byLabel: [1, 2, 3, 4], answer: null }]);
  assert.deepEqual(accepted(map, 0).sheets, [0, 1, 2, 3, 4, 5]);
});

test("a sheet without text keeps its label's answer where its neighbours kept theirs", () => {
  const labels = ["i", "ii", "1", "2"];
  const version = labelled(...[text(1), plate(), text(3), text(4)].map((sheet, index) => ({ ...sheet, label: labels[index] })));
  const map = pairSheets(version, version);
  assert.deepEqual(map.sheets, [0, 1, 2, 3]);
  assert.deepEqual(map.runs, []);
});

test("a sheet whose text was rebuilt is proposed the sheet at its place", () => {
  // The same sheets, and the third read anew from nothing: no letter of its old text survives.
  const map = pairSheets(unlabelled(text(1), text(2), text(30), text(4)), unlabelled(text(1), text(2), text(3), text(4)));
  assert.deepEqual(map.sheets, [0, 1, UNMAPPED, 3]);
  assert.deepEqual(map.runs, [{ kind: "place", start: 2, proposed: [2], answer: null }]);
  assert.deepEqual(accepted(map, 0).sheets, [0, 1, 2, 3]);
});

test("a rebuilt sheet inside a stretch of corrected labels is a question of its own", () => {
  const base = lateLabels(page(1), page(2), page(3), page(40), page(5), page(6));
  const version = rightLabels(page(1), page(2), page(3), page(4), page(5), page(6));
  const map = pairSheets(base, version);
  assert.deepEqual(
    map.runs.map((run) => [run.kind, run.start, run.proposed]),
    [
      ["labels", 2, [2]],
      ["place", 3, [3]],
      ["labels", 4, [4, 5]],
    ],
  );
  // Accepted in any order, no two sheets take one counterpart.
  const all = accepted(accepted(accepted(map, 1), 2), 0);
  assert.deepEqual(all.sheets, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(pageMapFaults(all, { base: 6, version: 6 }), []);
});

test("a sheet no rule can place is left unmapped", () => {
  const map = pairSheets(unlabelled(text(1), text(20), text(3)), unlabelled(text(1), text(21), text(22), text(3)));
  assert.deepEqual(map.sheets, [0, UNMAPPED, 3]);
  assert.deepEqual(map.runs, []);
  assert.deepEqual(pageMapNumbers(map), { paired: 2, removed: 0, unmapped: 1, openRuns: 0 });
});

test("a reflowed pair is left unmapped", () => {
  const words = letters(50, 1200);
  // A sheet whose words now run over two sheets: neither is its counterpart.
  const over = pairSheets(
    unlabelled(text(1), { skeleton: words, label: "", ink: true }, text(3)),
    unlabelled(text(1), { skeleton: words.slice(0, 700), label: "", ink: true }, { skeleton: words.slice(700), label: "", ink: true }, text(3)),
  );
  assert.deepEqual(over.sheets, [0, UNMAPPED, 3]);
  assert.deepEqual(over.runs, []);
  // Two sheets that passed lines between them: each holds most of its
  // counterpart's words, and too many of them are on the neighbour. They are
  // unmapped, and asked about by their place.
  const first = letters(60, 1200);
  const second = letters(61, 1200);
  const moved = pairSheets(
    unlabelled(text(1), { skeleton: first, label: "", ink: true }, { skeleton: second, label: "", ink: true }, text(4)),
    unlabelled(text(1), { skeleton: first + second.slice(0, 200), label: "", ink: true }, { skeleton: second.slice(200), label: "", ink: true }, text(4)),
  );
  assert.deepEqual(moved.sheets, [0, UNMAPPED, UNMAPPED, 3]);
  assert.deepEqual(moved.runs, [{ kind: "place", start: 1, proposed: [1, 2], answer: null }]);
});

test("a sheet is carried through the maps between two versions, in either direction", () => {
  const versions: MapVersion[] = [
    { number: 1, base: null, map: null },
    // Version 2 lost version 1's first sheet.
    { number: 2, base: 1, map: [REMOVED, 0, 1, 2] },
    // Version 3 gained a sheet after version 2's first.
    { number: 3, base: 2, map: [0, 2, 3] },
    // Version 4 was abandoned over version 3, and kept its map.
    { number: 4, base: 3, map: [0, 1, UNMAPPED, 2] },
    // Version 5 is a revised text: it has no map.
    { number: 5, base: 3, map: null },
    { number: 6, base: 5, map: [0, 1] },
  ];
  assert.deepEqual(carrySheet(2, 1, 3, versions), { kind: "carried", sheet: 2 });
  assert.deepEqual(carrySheet(3, 1, 3, versions), { kind: "carried", sheet: 3 });
  assert.deepEqual(carrySheet(0, 1, 3, versions), { kind: "no-counterpart" });
  // Backwards, to an earlier version.
  assert.deepEqual(carrySheet(3, 3, 1, versions), { kind: "carried", sheet: 3 });
  // The sheet version 3 gained is one version 2 lacks.
  assert.deepEqual(carrySheet(1, 3, 2, versions), { kind: "no-counterpart" });
  // Off an abandoned version, back to its base and on.
  assert.deepEqual(carrySheet(2, 4, 3, versions), { kind: "carried", sheet: 3 });
  assert.deepEqual(carrySheet(2, 4, 1, versions), { kind: "carried", sheet: 3 });
  assert.deepEqual(carrySheet(2, 3, 4, versions), { kind: "no-counterpart" });
  // A map missing on the way.
  assert.deepEqual(carrySheet(0, 3, 5, versions), { kind: "no-map" });
  assert.deepEqual(carrySheet(0, 1, 6, versions), { kind: "no-map" });
  assert.deepEqual(carrySheet(0, 6, 4, versions), { kind: "no-map" });
  assert.deepEqual(carrySheet(1, 5, 6, versions), { kind: "carried", sheet: 1 });
  assert.ok(mapsJoin(1, 4, versions));
  assert.ok(!mapsJoin(2, 6, versions));
  // A version the file never had.
  assert.deepEqual(carrySheet(0, 9, 3, versions), { kind: "no-map" });
  assert.deepEqual(carrySheet(7, 3, 3, versions), { kind: "carried", sheet: 7 });
  assert.equal(counterpartBack([REMOVED, 0, 1, 2], 1), 2);
  assert.equal(counterpartBack([REMOVED, 0, 1, 2], 3), null);
});

test("a stored map is read back, and a value that isn't one is refused", () => {
  const map = pairSheets(unlabelled(text(1), text(20), text(3), blank()), unlabelled(text(1), text(2), text(3)));
  assert.deepEqual(parsePageMap(JSON.parse(JSON.stringify(map))), map);
  assert.equal(parsePageMap(null), null);
  assert.equal(parsePageMap({ ...map, sheets: [0, 1] }), null);
  assert.equal(parsePageMap({ ...map, sheets: [0, 1, 9, REMOVED] }), null);
  assert.equal(parsePageMap({ ...map, runs: [{ kind: "place", start: 3, proposed: [0, 1], answer: null }] }), null);
  assert.equal(parsePageMap({ ...map, runs: [{ kind: "other", start: 1, proposed: [1], answer: null }] }), null);
  assert.equal(parsePageMap({ ...map, blank: { from: [9], to: [] } }), null);
});

test("the integrity check's reading of a map", () => {
  const sound = pairSheets(unlabelled(text(1), text(2), text(30)), unlabelled(text(1), text(2), text(3)));
  assert.deepEqual(pageMapFaults(sound, { base: 3, version: 3 }), []);
  assert.equal(pageMapFaults(sound, { base: 4, version: 3 }).length, 1);
  assert.equal(pageMapFaults({ ...sound, sheets: [0, 0, UNMAPPED] }, { base: 3, version: 3 }).length, 1);
  // A run that is not accepted, with its sheet written in all the same.
  assert.equal(pageMapFaults({ ...sound, sheets: [0, 1, 2] }, { base: 3, version: 3 }).length, 1);
});
