import assert from "node:assert/strict";
import { test } from "node:test";
import { movedFromWords, noPlaceWords, suggestionWords, worklistKindWords } from "./file-note-words";

// docs/PDF.md §13, "Moving a note forward" — what a suggestion, a note with
// no place and a card's move line say.

test("a suggestion says how it was found, and a proposal what keeps it from being sure", () => {
  assert.equal(suggestionWords({ kind: "placed", how: "sheet" }, 2), "Found on the matching sheet of version 2.");
  assert.equal(suggestionWords({ kind: "placed", how: "version" }, 3), "Found once in version 3, with the same words around it.");
  assert.match(suggestionWords({ kind: "proposal", how: "version" }, 3), /^Found in version 3, though not surely/);
  assert.equal(suggestionWords({ kind: "placed", how: "corrected", changed: 0.2 }, 2), "Found on the matching sheet of version 2 with its words changed (about 20% of its letters).");
  assert.match(suggestionWords({ kind: "proposal", how: "corrected", changed: 0.5 }, 2), /many of its words changed \(about 50% of its letters\)\.$/);
  // A change too small to round to a percent is still said to be one.
  assert.match(suggestionWords({ kind: "placed", how: "corrected", changed: 0.001 }, 2), /about 1% of its letters/);
  for (const how of ["unmoved", "fitted", "no-text"] as const) assert.match(suggestionWords({ kind: "proposal", how }, 4), /version 4/);
});

test("a note with no place says why, naming the version", () => {
  for (const why of ["not-found", "several", "no-sheet", "no-fit", "other-box", "unmeasurable"] as const) {
    assert.match(noPlaceWords(why, 5), /[vV]ersion 5/);
  }
  assert.equal(noPlaceWords("not-found", 2), "Its words were not found in version 2.");
});

test("a card says which version its note was moved from, and who moved it where that is not its author", () => {
  assert.equal(movedFromWords({ fromNumber: 1, toNumber: 2, by: null }, 2), "Moved from version 1.");
  assert.equal(movedFromWords({ fromNumber: 1, toNumber: 2, by: "A Manager" }, 2), "Moved from version 1 by A Manager.");
  // An earlier move of a note that has moved on since names where it reached.
  assert.equal(movedFromWords({ fromNumber: 1, toNumber: 2, by: null }, 3), "Moved from version 1 to version 2.");
});

test("a worklist's line calls its note by what it is", () => {
  assert.equal(worklistKindWords("note", ""), "Note");
  assert.equal(worklistKindWords("draft", ""), "Private note");
  assert.equal(worklistKindWords("part", "Idolatry"), "Part of the link “Idolatry”");
  assert.equal(worklistKindWords("part", ""), "Part of a link");
  assert.equal(worklistKindWords("open-part", "ignored"), "Part of the link in your tray");
});
