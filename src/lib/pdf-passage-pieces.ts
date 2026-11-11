import {
  MAX_FRAGMENT_PASSAGES,
  PASSAGE_END_WORDS,
  WHOLE_PASSAGE_MAX_WORDS,
  countPassageOccurrences,
  fragmentWords,
  resolvePassage,
  segmentRanges,
  segmentedWriterForm,
  type PassageSegment,
  type PassageText,
  type Skeleton,
  type TextRange,
} from "./pdf-fragment";

// docs/PDF_FRAGMENT_LINKS.md §2, "A quotation's segments" — a written
// quotation as a passage: where its words left out are, and on which pages
// its words lie. Two halves, both pure and isomorphic:
//
// - **`quotationText`** turns a quotation as the prose holds it into a `text`
//   value, with no page in sight: what a citation's link carries
//   (docs/CITATIONS.md, "A passage in a citation"). An ellipsis, and a
//   bracket standing alone, are a gap (`...`); a bracket attached to a word
//   keeps its brackets, since only the page can say whether its letters are
//   the source's.
// - **`passagePieces`** settles that value against the stored text of the
//   pages: each attached bracket with its letters or without, whichever the
//   page holds, and the page breaks the quotation crosses. What it answers
//   holds no bracket, and is in the writer's form.
//
// The cited-page route, the integrity check, MCP's write check and the
// one-quote CLI all call `passagePieces`, so all four agree.

// ---- a written quotation, as a `text` value --------------------------------

const MARK = /\p{M}/u;
const WORD = /[\p{L}\p{N}]/u;
// Where an attached bracket stands in a word while it is split into words.
const OPEN = "";
const CLOSE = "";

// What a quotation marks a gap with: an ellipsis, as `...`, `…` or `. . .`,
// bracketed or not; and any other bracket, standing alone or attached.
const MARKERS = /\[\s*(?:…|\.(?:\s*\.){2,})\s*\]|…|\.(?:\s*\.){2,}|\[([^[\]]*)\]/gu;

/**
 * The runs of a quotation its gaps separate, in order, each with its attached
 * brackets marked. A bracket is attached when a letter or digit touches it on
 * either side and it holds letters or digits only (`[T]he`, `form[s]`);
 * otherwise it stands alone (`[sic]`, `[the soul]`) and is a gap, which takes
 * with it whatever else is attached to it up to the next space, so the `'s` of
 * `[the soul]'s` is no word of its own.
 */
function quotedRuns(quotation: string): string[] {
  const source = quotation.replace(/[]/g, "");
  const runs: string[] = [];
  let run = "";
  let done = 0;
  for (const match of source.matchAll(MARKERS)) {
    const at = match.index;
    if (at < done) continue;
    run += source.slice(done, at);
    done = at + match[0].length;
    const inner = match[1];
    if (inner !== undefined) {
      const touches = WORD.test(source[at - 1] ?? "") || WORD.test(source[done] ?? "");
      if (touches && /^[\p{L}\p{N}\p{M}]+$/u.test(inner)) {
        run += `${OPEN}${inner}${CLOSE}`;
        continue;
      }
      run = run.replace(/\S*$/, "");
      done += /^\S*/.exec(source.slice(done))![0].length;
    }
    runs.push(run);
    run = "";
  }
  runs.push(run + source.slice(done));
  return runs;
}

/** A run's words as a writer emits them (`fragmentWords`), an attached bracket kept inside its word. */
function runWords(run: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const ch of run) {
    if (ch === OPEN || ch === CLOSE) {
      word += ch;
      continue;
    }
    for (const piece of ch.normalize("NFKD")) {
      if (MARK.test(piece)) continue;
      if (WORD.test(piece)) {
        word += piece;
      } else if (word) {
        words.push(word);
        word = "";
      }
    }
  }
  if (word) words.push(word);
  return words.filter((each) => WORD.test(each));
}

/** One word, its brackets as `%5B` and `%5D`: letters and digits need no encoding but for those with no ASCII base. */
function encodeWord(word: string): string {
  return [...word].map((ch) => (ch === OPEN ? "%5B" : ch === CLOSE ? "%5D" : encodeURIComponent(ch))).join("");
}

const encodeRun = (words: readonly string[]) => words.map(encodeWord).join("+");

/**
 * A written quotation as a `text` value: its runs joined by `...`, each run's
 * words by `+`, an attached bracket kept (`%5BT%5Dhe`). With `shorten`, a run
 * longer than eight words goes as its first and last three, the writer's
 * form's length rule without its step for uniqueness, which needs the page
 * (PDF_FRAGMENT_LINKS.md §8). Null when the quotation has no words.
 */
export function quotationText(quotation: string, opts: { shorten: boolean }): string | null {
  const runs = quotedRuns(quotation)
    .map(runWords)
    .filter((words) => words.length > 0);
  if (runs.length === 0) return null;
  return runs
    .map((words) =>
      opts.shorten && words.length > WHOLE_PASSAGE_MAX_WORDS
        ? `${encodeRun(words.slice(0, PASSAGE_END_WORDS))},${encodeRun(words.slice(-PASSAGE_END_WORDS))}`
        : encodeRun(words),
    )
    .join("...");
}

// ---- the pieces, against the pages -----------------------------------------

/** A page's stored text, as the check holds it. */
export type PieceSheet = { text: string; skeleton: Skeleton };

/** One page's share of a quotation: the 0-based sheet, the passage in the writer's form, the range it covers and how many places it matches there. */
export type PlacedPassage = { sheet: number; passage: PassageText; range: TextRange; occurrences: number };

const BRACKET = /\[([^[\]]*)\]/g;
// More attached brackets than this in one quotation are tried all kept and all dropped only.
const MAX_TRIED_BRACKETS = 4;

/**
 * Every reading of `parts` with each attached bracket's letters kept or
 * dropped, kept first: "[T]he" matches only with them kept, and "form[s]"
 * against a source's "form" only with them dropped.
 */
function bracketReadings(parts: readonly string[]): string[][] {
  const count = parts.reduce((sum, part) => sum + (part.match(BRACKET)?.length ?? 0), 0);
  const choices: ((n: number) => boolean)[] =
    count <= MAX_TRIED_BRACKETS
      ? Array.from({ length: 2 ** count }, (_, bits) => (n: number) => ((bits >> n) & 1) === 1)
      : [() => false, () => true];
  return choices.map((dropped) => {
    let n = 0;
    return parts.map((part) => part.replace(BRACKET, (_whole, inner: string) => (dropped(n++) ? "" : inner)).replace(/[[\]]/g, ""));
  });
}

/** A passage read with its brackets settled one way, as `bracketReadings` lists them. */
function passageReadings(text: PassageText): PassageText[] {
  const parts = text.segments.flatMap((segment) => [segment.start, segment.end ?? ""]);
  return bracketReadings(parts).map((read) => ({
    prefix: text.prefix?.replace(/[[\]]/g, "") ?? null,
    segments: text.segments.map((segment, index) => ({ start: read[2 * index], end: segment.end === null ? null : read[2 * index + 1] })),
    suffix: text.suffix?.replace(/[[\]]/g, "") ?? null,
  }));
}

function segmentReadings(segment: PassageSegment): PassageSegment[] {
  return bracketReadings([segment.start, segment.end ?? ""]).map(([start, end]) => ({ start, end: segment.end === null ? null : end }));
}

/**
 * A page's share in the writer's form: whole segments shortened by the
 * writer's rule where that still finds this range, and otherwise the
 * segments as they were placed.
 */
function placed(sheet: number, page: PieceSheet, segments: readonly PassageSegment[], range: TextRange): PlacedPassage {
  const asPlaced: PassageText = { prefix: null, segments, suffix: null };
  const form = segments.every((segment) => segment.end === null)
    ? (segmentedWriterForm(page.text, range, segments.map((segment) => fragmentWords(segment.start))) ?? asPlaced)
    : asPlaced;
  return { sheet, passage: form, range, occurrences: countPassageOccurrences(page.text, form, page.skeleton) };
}

/**
 * A quotation's pieces, page by page (PDF_FRAGMENT_LINKS.md §2): `text` read
 * as a `text` value, its words perhaps still holding brackets, against the
 * stored text of `pages` (0-based sheets).
 *
 * The passage starts on the first of `startSheets` that holds it, and may run
 * on from a sheet as far as `throughSheet(start)`, never past
 * `MAX_FRAGMENT_PASSAGES` sheets. It is looked for on one sheet first, as it
 * is written, prefix and suffix included; then across sheets, segment by
 * segment, each after the one before:
 *
 * - a segment that isn't on the sheet the one before it ended on is looked
 *   for whole on the sheets after it, since the elision before it may
 *   straddle the break, or a page;
 * - then, where it is whole (not `start,end`, whose middle no page text
 *   gives), split at a word boundary across the break, its first part at its
 *   last match on the sheet, nearest the break, as `splitAcrossPages` splits a
 *   quote.
 *
 * Each attached bracket is tried with its letters kept, then dropped. Null
 * when the passage can't be placed.
 */
export function passagePieces(
  text: PassageText,
  pages: ReadonlyMap<number, PieceSheet>,
  startSheets: readonly number[],
  throughSheet: (start: number) => number = (start) => start,
): PlacedPassage[] | null {
  for (const start of startSheets) {
    const page = pages.get(start);
    if (!page) continue;
    for (const reading of passageReadings(text)) {
      const range = resolvePassage(page.text, reading, page.skeleton);
      if (!range) continue;
      if (reading.prefix !== null || reading.suffix !== null) {
        return [{ sheet: start, passage: reading, range, occurrences: countPassageOccurrences(page.text, reading, page.skeleton) }];
      }
      return [placed(start, page, reading.segments, range)];
    }
  }
  for (const start of startSheets) {
    const last = Math.min(throughSheet(start), start + MAX_FRAGMENT_PASSAGES - 1);
    if (last <= start) continue;
    const across = placeAcross(text.segments, pages, start, last);
    if (across) return across;
  }
  return null;
}

/** The segments placed one after another from sheet `start`, onto sheets as far as `last`; null when one can't be. */
function placeAcross(segments: readonly PassageSegment[], pages: ReadonlyMap<number, PieceSheet>, start: number, last: number): PlacedPassage[] | null {
  const bySheet = new Map<number, { segments: PassageSegment[]; ranges: TextRange[] }>();
  const add = (sheet: number, segment: PassageSegment, range: TextRange) => {
    let entry = bySheet.get(sheet);
    if (!entry) bySheet.set(sheet, (entry = { segments: [], ranges: [] }));
    entry.segments.push(segment);
    entry.ranges.push(range);
  };
  let sheet = start;
  let from = 0;
  const firstOn = (index: number, segment: PassageSegment, offset: number) => {
    const page = pages.get(index);
    return page ? (segmentRanges(page.text, segment, offset, page.skeleton, true)[0] ?? null) : null;
  };

  for (const [i, segment] of segments.entries()) {
    const readings = segmentReadings(segment);
    let done = false;
    for (const reading of readings) {
      const range = firstOn(sheet, reading, from);
      if (range) {
        add(sheet, reading, range);
        from = range.end;
        done = true;
        break;
      }
    }
    // The elision before it straddles the break: the whole segment on a later sheet.
    for (let later = sheet + 1; !done && i > 0 && later <= last; later++) {
      for (const reading of readings) {
        const range = firstOn(later, reading, 0);
        if (range) {
          add((sheet = later), reading, range);
          from = range.end;
          done = true;
          break;
        }
      }
    }
    // The segment straddles it: split at a word boundary.
    for (const reading of readings) {
      if (done || reading.end !== null || sheet + 1 > last) break;
      const split = splitSegment(pages.get(sheet), from, pages.get(sheet + 1), fragmentWords(reading.start));
      if (!split) continue;
      add(sheet, { start: split.firstWords.join(" "), end: null }, split.first);
      add((sheet += 1), { start: split.nextWords.join(" "), end: null }, split.next);
      from = split.next.end;
      done = true;
    }
    if (!done) return null;
  }

  return [...bySheet].map(([index, entry]) =>
    placed(index, pages.get(index)!, entry.segments, { start: entry.ranges[0].start, end: entry.ranges[entry.ranges.length - 1].end }),
  );
}

/** One segment's words across a break: the first part at its last match on `first` from offset `from`, the rest at its first on `next`. */
function splitSegment(
  first: PieceSheet | undefined,
  from: number,
  next: PieceSheet | undefined,
  words: readonly string[],
): { first: TextRange; firstWords: string[]; next: TextRange; nextWords: string[] } | null {
  if (!first || !next) return null;
  for (let split = 1; split < words.length; split++) {
    const firstWords = words.slice(0, split);
    const nextWords = words.slice(split);
    const firsts = segmentRanges(first.text, { start: firstWords.join(" "), end: null }, from, first.skeleton);
    if (firsts.length === 0) continue;
    const after = segmentRanges(next.text, { start: nextWords.join(" "), end: null }, 0, next.skeleton, true)[0];
    if (!after) continue;
    return { first: firsts[firsts.length - 1], firstWords, next: after, nextWords };
  }
  return null;
}
