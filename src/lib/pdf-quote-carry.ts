import { diffText, tokenizeFine } from "./diff";
import { skeletonOf, type TextRange } from "./pdf-fragment";

// docs/PDF.md §13, "Placing each anchor": a quote whose words were corrected
// on the sheet it maps to. The quote is no longer there, so its old range is
// carried through a diff of the two sheets' text, and it places itself where
// both its ends come through at a word boundary and no more than a third of
// its letters changed.
//
// Pure. The rule and its one number were settled on real pairs of files
// (§13, "How the numbers were measured"), so changing either means measuring
// again.

type Token = {
  start: number;
  end: number;
  word: boolean;
  /** The token of the other sheet this one equals, where the diff found one. */
  mate: number | null;
  /** The run this word is in, where the diff found it no mate. */
  run: number | null;
};

/** The words of each sheet, in order, that stand between two shared words. */
type Run = { earlier: number[]; later: number[] };

/** Two sheets' text as the diff pairs it: both token lists and the changed runs. */
export type SheetWords = { earlier: Token[]; later: Token[]; runs: Run[] };

const WORD = /^[\p{L}\p{N}]/u;

/**
 * The diff of two sheets' text, read for carrying a range.
 *
 * **A run is what stands between two shared words.** The diff also matches
 * the space or the comma between two changed words, and a run cut there
 * pairs "empiricafphenomenon" with "empirical" and loses "phenomenon". So a
 * shared token that is not a word ends no run.
 */
export function alignSheetWords(earlier: string, later: string): SheetWords {
  const words: SheetWords = { earlier: [], later: [], runs: [] };
  let at = 0;
  let to = 0;
  let run: Run | null = null;
  const close = () => {
    if (run) words.runs.push(run);
    run = null;
  };
  for (const token of diffText(earlier, later, tokenizeFine)) {
    const word = WORD.test(token.value);
    const length = token.value.length;
    if (token.type === "equal") {
      if (word) close();
      words.earlier.push({ start: at, end: at + length, word, mate: words.later.length, run: null });
      words.later.push({ start: to, end: to + length, word, mate: words.earlier.length - 1, run: null });
      at += length;
      to += length;
      continue;
    }
    run ??= { earlier: [], later: [] };
    const side = token.type === "delete" ? words.earlier : words.later;
    const offset = token.type === "delete" ? at : to;
    if (word) (token.type === "delete" ? run.earlier : run.later).push(side.length);
    side.push({ start: offset, end: offset + length, word, mate: null, run: word ? words.runs.length : null });
    if (token.type === "delete") at += length;
    else to += length;
  }
  close();
  return words;
}

/** The length of the longest run of letters, in order, that both strings hold. */
function commonLetters(a: string, b: string): number {
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * How much of a quote changed, letter by letter: of the two quotes' skeletons
 * together, the share outside the longest run of letters, in order, that both
 * hold. "modem" to "modern" is 3 of 11. Counted in words a one-word quote
 * that changed is wholly changed, which says nothing.
 */
export function lettersChanged(oldQuote: string, newQuote: string): number {
  const a = skeletonOf(oldQuote).text;
  const b = skeletonOf(newQuote).text;
  return a.length + b.length === 0 ? 0 : 1 - (2 * commonLetters(a, b)) / (a.length + b.length);
}

/** Whether no more than a third of the two quotes' letters changed, in whole letters: a float puts 4 of 12 over a third. */
function withinAThird(oldQuote: string, newQuote: string): boolean {
  const a = skeletonOf(oldQuote).text;
  const b = skeletonOf(newQuote).text;
  return 3 * (a.length + b.length - 2 * commonLetters(a, b)) <= a.length + b.length;
}

/**
 * Where a range of the earlier sheet's text is on the later sheet.
 *
 * - **placed**: both ends came through, each in a word the sheets share or in
 *   a run the diff replaces word for word, and no more than a third of the
 *   quote's letters changed. It places itself.
 * - **proposal**: it was carried, but an end stands on the first or last word
 *   of a run that is not word for word, or more than a third changed. A
 *   person accepts it or doesn't.
 * - **none**: an end is inside a run that is not word for word, or the range
 *   holds no word.
 *
 * The range goes by the words it touches. It keeps what punctuation and
 * space it began or ended with where the later sheet has the same beside
 * those words, and its place inside a shared word it began or ended within.
 */
export type CarriedRange = { kind: "placed" | "proposal"; range: TextRange; changed: number } | { kind: "none" };

type End = { token: number; how: "shared" | "word for word" | "edge" };

function carryEnd(words: SheetWords, index: number, side: "start" | "end"): End | null {
  const token = words.earlier[index];
  if (token.mate !== null) return { token: token.mate, how: "shared" };
  const run = words.runs[token.run!];
  const at = run.earlier.indexOf(index);
  if (run.earlier.length === run.later.length) return { token: run.later[at], how: "word for word" };
  if (run.later.length === 0) return null;
  if (side === "start" && at === 0) return { token: run.later[0], how: "edge" };
  if (side === "end" && at === run.earlier.length - 1) return { token: run.later[run.later.length - 1], how: "edge" };
  return null;
}

export function carryRange(
  earlier: string,
  later: string,
  range: TextRange,
  words: SheetWords = alignSheetWords(earlier, later),
): CarriedRange {
  let first = -1;
  let last = -1;
  words.earlier.forEach((token, index) => {
    if (!token.word || token.end <= range.start || token.start >= range.end) return;
    if (first < 0) first = index;
    last = index;
  });
  if (first < 0) return { kind: "none" };

  const from = carryEnd(words, first, "start");
  const to = carryEnd(words, last, "end");
  if (!from || !to || from.token > to.token) return { kind: "none" };

  let start = words.later[from.token].start;
  let end = words.later[to.token].end;
  // Inside a shared word, the same letters stand at the same place in both.
  if (from.how === "shared") start += Math.max(0, range.start - words.earlier[first].start);
  if (to.how === "shared") end -= Math.max(0, words.earlier[last].end - range.end);
  // The punctuation and space the range began and ended with, where the later sheet has them too.
  for (let k = first - 1, n = from.token - 1; k >= 0 && n >= 0; k--, n--) {
    const token = words.earlier[k];
    if (token.word || token.start < range.start || token.mate !== n) break;
    start = words.later[n].start;
  }
  for (let k = last + 1, n = to.token + 1; k < words.earlier.length && n < words.later.length; k++, n++) {
    const token = words.earlier[k];
    if (token.word || token.end > range.end || token.mate !== n) break;
    end = words.later[n].end;
  }
  if (start >= end) return { kind: "none" };

  const oldQuote = earlier.slice(range.start, range.end);
  const newQuote = later.slice(start, end);
  const clean = from.how !== "edge" && to.how !== "edge";
  return {
    kind: clean && withinAThird(oldQuote, newQuote) ? "placed" : "proposal",
    range: { start, end },
    changed: lettersChanged(oldQuote, newQuote),
  };
}
