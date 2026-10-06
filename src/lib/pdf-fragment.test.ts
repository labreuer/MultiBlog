import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FRAGMENT_PASSAGES,
  countPassageOccurrences,
  formatFragmentPassages,
  fragmentWords,
  parseFragmentPassages,
  resolvePassage,
  splitAcrossPages,
  writerForm,
  type PassageText,
} from "./pdf-fragment";

// docs/PDF_FRAGMENT_LINKS.md — the fragment's grammar and the skeleton match,
// whose rejection surface is the point. The page texts below are written to
// carry what a real extraction does to a book: words broken apart ("bea
// tific", "imagin ation"), letter-spaced ("o f", "W e"), run together
// ("ofAge"), a line-end hyphen kept ("inter- national"), and a folio and
// running head at the foot of a page.

const PAGE = [
  "W e have seen that the law o f participation governs the earlier mind.",
  "It is a direction in which we had all better be moving, rather than a bea tific consummation.",
  "The law o f identity, but o f the law o f partici pation, as he puts it.",
  "That is imagin ation. Romanticism Comes ofAge in the inter- national style.",
  "Footnotes such as this one12 sit inside a passage.",
  "The individual breathe totem feels he is the totem.",
].join(" ");

const whole = (start: string, extra: Partial<PassageText> = {}): PassageText => ({
  prefix: null,
  start,
  end: null,
  suffix: null,
  ...extra,
});

const text = (page: string, passage: PassageText) => {
  const range = resolvePassage(page, passage);
  return range ? page.slice(range.start, range.end) : null;
};

// ---- the grammar ---------------------------------------------------------

test("each text belongs to the page before it, read left to right", () => {
  assert.deepEqual(parseFragmentPassages("#page=12&text=could+not+yet&page=13&text=a,b"), [
    { page: 12, prefix: null, start: "could not yet", end: null, suffix: null },
    { page: 13, prefix: null, start: "a", end: "b", suffix: null },
  ]);
  // Two texts on one page, and no leading #.
  assert.equal(parseFragmentPassages("page=4&text=one&text=two").length, 2);
});

test("a text with no valid page before it is ignored, and a bad page forgets the last good one", () => {
  assert.deepEqual(parseFragmentPassages("#text=orphan&page=2&text=kept"), [
    { page: 2, prefix: null, start: "kept", end: null, suffix: null },
  ]);
  for (const bad of ["0", "-1", "2x", "1.5", ""]) {
    assert.deepEqual(parseFragmentPassages(`#page=3&text=a&page=${bad}&text=b`).map((p) => p.start), ["a"], bad);
  }
});

test("prefix and suffix markers are read before decoding, so encoded ones are text", () => {
  assert.deepEqual(parseFragmentPassages("#page=1&text=before+this-,the+start,the+end,-after+that")[0], {
    page: 1,
    prefix: "before this",
    start: "the start",
    end: "the end",
    suffix: "after that",
  });
  // %2C is a comma inside the text, not a separator.
  assert.deepEqual(parseFragmentPassages("#page=1&text=God%2C+but+nothing")[0].end, null);
  // A hyphen inside a word, with no comma beside it, is text too.
  assert.equal(parseFragmentPassages("#page=1&text=self-consciousness")[0].start, "self-consciousness");
});

test("spaces arrive as + or %20 alike", () => {
  const plus = parseFragmentPassages("#page=1&text=the+law")[0];
  const encoded = parseFragmentPassages("#page=1&text=the%20law")[0];
  assert.equal(plus.start, encoded.start);
});

test("a passage that doesn't parse, or has a part with no letters, is dropped", () => {
  for (const bad of ["a,b,c", "%E0%A4%A", "...", "-,", "x,-", ",", "a-,", ",-z"]) {
    assert.deepEqual(parseFragmentPassages(`#page=1&text=${bad}`), [], bad);
  }
});

test("other parameters and an annotation permalink are ignored", () => {
  assert.deepEqual(parseFragmentPassages("#zoom=200&page=2&text=kept&search=x"), [
    { page: 2, prefix: null, start: "kept", end: null, suffix: null },
  ]);
  assert.deepEqual(parseFragmentPassages("#ada-lovelace-2026-10-04-12-00-00"), []);
  assert.deepEqual(parseFragmentPassages(""), []);
});

test("at most MAX_FRAGMENT_PASSAGES passages are read", () => {
  const hash = Array.from({ length: 20 }, (_, i) => `page=${i + 1}&text=word${i}`).join("&");
  assert.equal(parseFragmentPassages(hash).length, MAX_FRAGMENT_PASSAGES);
});

test("a writer emits letters and digits joined by +, folding accents and keeping case", () => {
  assert.deepEqual(fragmentWords("could not yet ‘call his soul his own’."), ["could", "not", "yet", "call", "his", "soul", "his", "own"]);
  assert.deepEqual(fragmentWords("Lévy-Bruhl’s ﬁnding"), ["Levy", "Bruhl", "s", "finding"]);
  assert.equal(
    formatFragmentPassages([{ page: 30, prefix: "identity, but of the", start: "law of participation", end: null, suffix: null }]),
    "page=30&text=identity+but+of+the-,law+of+participation",
  );
  assert.equal(
    formatFragmentPassages([
      { page: 40, prefix: null, start: "It may also", end: "within, but it", suffix: null },
      { page: 41, prefix: null, start: "is detected", end: null, suffix: "primarily" },
    ]),
    "page=40&text=It+may+also,within+but+it&page=41&text=is+detected,-primarily",
  );
  // A letter with no ASCII base is percent-encoded, and survives the round trip.
  const greek = formatFragmentPassages([{ page: 1, prefix: null, start: "εἴδωλον", end: null, suffix: null }]);
  assert.match(greek, /^page=1&text=%/);
  assert.equal(fragmentWords(parseFragmentPassages(greek)[0].start).join(" "), fragmentWords("εἴδωλον").join(" "));
});

// ---- the match -----------------------------------------------------------

test("the skeleton forgives what extraction does to words", () => {
  assert.equal(text(PAGE, whole("a beatific consummation")), "a bea tific consummation");
  assert.equal(text(PAGE, whole("We have seen")), "W e have seen");
  assert.equal(text(PAGE, whole("That is imagination")), "That is imagin ation");
  assert.equal(text(PAGE, whole("the international style")), "the inter- national style");
  assert.equal(text(PAGE, whole("“Comes of Age”")), "Comes ofAge");
});

test("a match starts and ends on a word boundary of the page", () => {
  // "the totem" is also the tail of "breathe totem" — the boundary rule skips it.
  const range = resolvePassage(PAGE, whole("the totem"));
  assert.ok(range);
  assert.equal(PAGE.slice(range.start - 12, range.end), "feels he is the totem");
  // A quote ending at a word the PDF ran into the next one misses rather than matching half a word.
  assert.equal(resolvePassage(PAGE, whole("Romanticism Comes of")), null);
});

test("a different word is a miss: the skeleton is exact in every letter", () => {
  assert.equal(resolvePassage(PAGE, whole("a beatific consumation")), null);
  assert.equal(resolvePassage(PAGE, whole("the law of particiption")), null);
});

test("start,end matches only the ends, so the middle may hold anything", () => {
  // The middle carries a footnote number that a whole quote without it would miss.
  assert.equal(resolvePassage(PAGE, whole("Footnotes such as this one sit inside a passage")), null);
  assert.equal(
    text(PAGE, whole("Footnotes such as", { end: "inside a passage" })),
    "Footnotes such as this one12 sit inside a passage",
  );
  // The end is looked for after the start, never before it.
  assert.equal(resolvePassage(PAGE, whole("the totem", { end: "We have seen" })), null);
});

test("the first occurrence wins, and a prefix or suffix picks another", () => {
  const first = resolvePassage(PAGE, whole("law of participation"))!;
  assert.equal(PAGE.slice(first.start - 9, first.end), "that the law o f participation");
  const second = resolvePassage(PAGE, whole("law of participation", { prefix: "identity but of the" }))!;
  assert.equal(PAGE.slice(second.start, second.end), "law o f partici pation");
  assert.ok(second.start > first.start);
  // A suffix that follows only the second occurrence.
  const bySuffix = resolvePassage(PAGE, whole("law of participation", { suffix: "as he puts it" }))!;
  assert.equal(bySuffix.start, second.start);
  assert.equal(countPassageOccurrences(PAGE, whole("law of participation")), 2);
  // A start that recurs inside the passage it begins is one passage, not two.
  assert.equal(countPassageOccurrences(PAGE, whole("the law", { end: "as he puts it" })), 1);
  assert.equal(countPassageOccurrences(PAGE, whole("law of participation", { suffix: "as he puts it" })), 1);
});

// ---- across a page break -------------------------------------------------

const PAGE_40_END = "us figuration. It may also sometimes be detected within, but it 4 1 Original Participation";
const PAGE_41_START = "is detected primarily without. The human soul may be one o f the stopping-places.";
const ACROSS = "It may also sometimes be detected within, but it is detected primarily without.";

test("a quote across a page break is no one passage, because the folio stands between", () => {
  assert.equal(resolvePassage(`${PAGE_40_END} ${PAGE_41_START}`, whole(ACROSS)), null);
});

test("splitAcrossPages finds the break and the passage on each side", () => {
  const split = splitAcrossPages(PAGE_40_END, PAGE_41_START, ACROSS)!;
  assert.ok(split);
  assert.equal(PAGE_40_END.slice(split.first.start, split.first.end), "It may also sometimes be detected within, but it");
  assert.equal(PAGE_41_START.slice(split.next.start, split.next.end), "is detected primarily without");
  assert.equal(splitAcrossPages(PAGE_40_END, PAGE_41_START, "nothing like either page"), null);
});

// ---- the writer's form ---------------------------------------------------

const rangeOf = (page: string, needle: string, from = 0) => {
  const start = page.indexOf(needle, from);
  assert.ok(start >= 0, needle);
  return { start, end: start + needle.length };
};

test("eight words or fewer go whole", () => {
  assert.deepEqual(writerForm(PAGE, rangeOf(PAGE, "W e have seen that")), whole("W e have seen that"));
});

test("a longer passage goes as three words at each end", () => {
  const range = rangeOf(PAGE, "It is a direction in which we had all better be moving, rather than a bea tific consummation");
  assert.deepEqual(writerForm(PAGE, range), whole("It is a", { end: "bea tific consummation" }));
});

test("a repeated passage gains words, and a repeated short one a prefix", () => {
  const second = rangeOf(PAGE, "law o f partici pation");
  const form = writerForm(PAGE, second)!;
  assert.ok(form.prefix, "a prefix tells the second occurrence from the first");
  assert.deepEqual(resolvePassage(PAGE, form), second);
});

test("the author's words stand in for the page's, and are verified", () => {
  const range = rangeOf(PAGE, "That is imagin ation");
  assert.deepEqual(writerForm(PAGE, range, ["That", "is", "imagination"]), whole("That is imagination"));
  // Words whose skeleton isn't this passage's find nothing.
  assert.equal(writerForm(PAGE, range, ["That", "is", "invention"]), null);
});

test("every writer's form resolves to its own range", () => {
  for (const needle of ["the earlier mind", "rather than a bea tific consummation", "feels he is the totem", "inter- national style"]) {
    const range = rangeOf(PAGE, needle);
    const form = writerForm(PAGE, range)!;
    assert.deepEqual(resolvePassage(PAGE, form), range, needle);
  }
});
