// docs/PDF.md §13, "Moving a note forward" — one note's move in words: how a
// suggestion was found, why a note has none, and what a card says of a move.
//
// Browser-safe: it takes plain shapes, and imports nothing from the modules
// that work them out (src/lib/file-note-move.ts, file-anchor-placements.ts).

type Found = "sheet" | "version" | "corrected" | "unmoved" | "fitted" | "no-text";
type NoPlace = "not-found" | "several" | "no-sheet" | "no-fit" | "other-box" | "unmeasurable";

/**
 * How a suggestion was found on version `toNumber`. A proposal says what
 * keeps it from being sure: the rules would not move the note by themselves.
 */
export function suggestionWords(suggestion: { kind: "placed" | "proposal"; how: Found; changed?: number }, toNumber: number): string {
  const share = suggestion.changed !== undefined ? ` (about ${Math.max(1, Math.round(suggestion.changed * 100))}% of its letters)` : "";
  switch (suggestion.how) {
    case "sheet":
      return `Found on the matching sheet of version ${toNumber}.`;
    case "version":
      return suggestion.kind === "placed"
        ? `Found once in version ${toNumber}, with the same words around it.`
        : `Found in version ${toNumber}, though not surely: the words around it differ, or it is there more than once.`;
    case "corrected":
      return suggestion.kind === "placed"
        ? `Found on the matching sheet of version ${toNumber} with its words changed${share}.`
        : `Found on the matching sheet of version ${toNumber} with many of its words changed${share}.`;
    case "unmoved":
      return `Its sheet's ink is where it was on the matching sheet of version ${toNumber}.`;
    case "fitted":
      return `Placed by fitting its sheet's words to the matching sheet of version ${toNumber}.`;
    case "no-text":
      return `Its sheet has no text. It is put at the same place on the matching sheet of version ${toNumber}, which has the same size.`;
  }
}

/** Why the placing rules give a note no place on version `toNumber`. */
export function noPlaceWords(why: NoPlace, toNumber: number): string {
  switch (why) {
    case "not-found":
      return `Its words were not found in version ${toNumber}.`;
    case "several":
      return `Its words are in version ${toNumber} more than once, and nothing says which is meant.`;
    case "no-sheet":
      return `It has no words to be found by, and its sheet has no matching sheet in version ${toNumber}.`;
    case "no-fit":
      return `It has no words to be found by, and its sheet's words couldn't be fitted to the matching sheet of version ${toNumber}.`;
    case "other-box":
      return `It has no words to be found by, and the matching sheet of version ${toNumber} has another size.`;
    case "unmeasurable":
      return `Version ${toNumber}'s sheet couldn't be measured.`;
  }
}

/**
 * What a card says of one move of its note, on the page of version
 * `shownNumber`: which version it was moved from, and who moved it where
 * that is not its author.
 */
export function movedFromWords(move: { fromNumber: number; toNumber: number; by: string | null }, shownNumber: number): string {
  const to = move.toNumber === shownNumber ? "" : ` to version ${move.toNumber}`;
  return `Moved from version ${move.fromNumber}${to}${move.by ? ` by ${move.by}` : ""}.`;
}

/** What a worklist's line calls its note. */
export function worklistKindWords(what: "note" | "draft" | "part" | "open-part", linkName: string): string {
  switch (what) {
    case "note":
      return "Note";
    case "draft":
      return "Private note";
    case "part":
      return linkName ? `Part of the link “${linkName}”` : "Part of a link";
    case "open-part":
      return "Part of the link in your tray";
  }
}
