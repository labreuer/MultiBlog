// PLAN.md §19 / docs/PDF.md §3 — turning one PDF page's `getTextContent()`
// output into a single normalised string, deterministically.
//
// **Everything about anchoring rests on this being a pure, versioned function
// of its input.** The same code runs in two places that must agree exactly: the
// Node-side extraction at upload (src/lib/pdf-extract.ts, whose output is
// stored in `file_page_text`) and the browser at selection time
// (src/lib/pdf-anchor-capture.ts). If the two ever produced different strings,
// a server-derived `quotedText` would disagree with the offsets the client
// measured, silently. Hence one module, no environment checks in it, and no
// dependency on pdfjs beyond the structural shape of a text item.
//
// Isomorphic on purpose: no `node:` imports, no DOM. It never reads rendered
// DOM either — docs/PDF.md §11 records Hypothesis capturing a placeholder's
// "Loading annotations…" text into a quote selector, which is exactly what
// computing selectors from anything but `getTextContent()` invites.

/**
 * Bump on **any** behavioural change below, however small — a different gap
 * threshold, one more character in the dash table, a reordering of the steps.
 *
 * It is half of the `textVersion` stamped into every stored anchor
 * (`${pdfjsVersion}/${NORMALISER_VERSION}`), and the contract that version
 * carries is "text produced by this exact pipeline". A change without a bump
 * makes previously-stored offsets point somewhere subtly wrong, with nothing
 * to detect it: the old rows would claim to have been measured against a
 * pipeline that no longer exists.
 */
export const NORMALISER_VERSION = 1;

export function textVersionFor(pdfjsVersion: string): string {
  return `${pdfjsVersion}/${NORMALISER_VERSION}`;
}

/**
 * The shape this module needs from a pdfjs `TextItem`, declared structurally
 * rather than imported. Keeps the normaliser free of a pdfjs import (so the
 * pure logic is testable and bundleable anywhere) and means a pdfjs upgrade
 * that widens `TextItem` doesn't touch this file.
 *
 * `transform` is the standard PDF text matrix `[a, b, c, d, e, f]`; `e`/`f`
 * are the item's origin in text space.
 */
export type PdfTextItemLike = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

/** Where one character of the normalised string came from. */
export type SourceOffset = { itemIndex: number; charOffset: number };

export type NormalisedPage = {
  text: string;
  /**
   * `offsets[i]` is the source of `text[i]`, which is what makes a stored
   * character range recoverable as quads *without* a rendered text layer — the
   * reason docs/PDF.md §3 insists this be built during the join rather than
   * reconstructed later. Same length as `text`.
   */
  offsets: SourceOffset[];
};

// Fraction of the item's font size beyond which a horizontal gap between two
// items means a word break. PDF.js frequently emits adjacent items with no
// space between them (docs/PDF.md §3 step 1), so without this, "the quick" is
// extracted as "thequick" and no quote ever matches.
//
// 0.2 rather than something tighter: kerning and justification routinely open
// gaps of a tenth of an em inside a single word, and a spurious space inside a
// word is worse than a missing one between two — it breaks the common case to
// fix the rare one.
const SPACE_GAP_RATIO = 0.2;

/** Vertical movement, as a fraction of font size, that counts as a new line even without `hasEOL`. */
const LINE_BREAK_RATIO = 0.5;

// U+00AD soft hyphen, U+200B..U+200D zero-width space/non-joiner/joiner,
// U+2060 word joiner, U+FEFF BOM. All invisible, all routinely present in
// extracted PDF text, and all fatal to an exact quote match if kept.
const INVISIBLE = /[­​‌‍⁠﻿]/;

// Ligature decomposition (docs/PDF.md §3 step 3). A PDF that renders "fi" as
// U+FB01 extracts it that way too, so a reader who selects "finding" would
// otherwise store a quote nothing later matches.
const LIGATURES = new Map<string, string>([
  ["ﬀ", "ff"],
  ["ﬁ", "fi"],
  ["ﬂ", "fl"],
  ["ﬃ", "ffi"],
  ["ﬄ", "ffl"],
  ["ﬅ", "st"],
  ["ﬆ", "st"],
]);

// Dashes and quotes to ASCII (step 5). Typographic quotes are the single most
// common reason a quote captured from one rendering fails to match another.
const PUNCTUATION = new Map<string, string>([
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
  ["‛", "'"],
  ["“", '"'],
  ["”", '"'],
  ["„", '"'],
  ["‟", '"'],
  ["‐", "-"],
  ["‑", "-"],
  ["‒", "-"],
  ["–", "-"],
  ["—", "-"],
  ["―", "-"],
  ["−", "-"],
]);

/**
 * docs/PDF.md §3's pipeline, in order, carrying per-character provenance the
 * whole way.
 *
 * **Deviation worth knowing: NFKC is applied per character, not to the joined
 * string.** §3 says "Unicode NFKC" without qualifying it, and whole-string
 * NFKC is marginally more correct for combining-mark sequences that straddle a
 * character boundary. It is also incompatible with an exact offset map, since
 * it can merge or reorder across characters with no way to attribute the
 * result. Per-character keeps `offsets` exact and keeps the function
 * deterministic, which is what §3 actually requires — and because *both* sides
 * that matter (upload extraction and selection capture) call this same
 * function, internal consistency is guaranteed regardless. Revisit only with a
 * NORMALISER_VERSION bump.
 */
export function normalisePageText(items: readonly PdfTextItemLike[]): NormalisedPage {
  // Step 1 — join, inserting the separators pdfjs omits.
  const raw: string[] = [];
  const rawOffsets: SourceOffset[] = [];

  const push = (ch: string, itemIndex: number, charOffset: number) => {
    raw.push(ch);
    rawOffsets.push({ itemIndex, charOffset });
  };

  let previous: PdfTextItemLike | null = null;
  let previousIndex = -1;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (previous) {
      const separator = separatorBetween(previous, item);
      // Attributed to the *end* of the previous item rather than the start of
      // this one: an inserted separator stands for the space the previous item
      // failed to close with, and a range that ends at the separator should
      // resolve to a quad ending with that item.
      if (separator) push(separator, previousIndex, previous.str.length);
    }
    for (let charOffset = 0; charOffset < item.str.length; charOffset++) {
      push(item.str[charOffset], itemIndex, charOffset);
    }
    previous = item;
    previousIndex = itemIndex;
  }

  // Steps 2-5 — per-character rewriting. One source character may expand to
  // several (a ligature) or to none (an invisible), and provenance follows.
  const mapped: string[] = [];
  const mappedOffsets: SourceOffset[] = [];

  for (let i = 0; i < raw.length; i++) {
    const source = rawOffsets[i];
    let ch = raw[i];
    if (INVISIBLE.test(ch)) continue;

    const ligature = LIGATURES.get(ch);
    if (ligature !== undefined) {
      for (const expanded of ligature) {
        mapped.push(expanded);
        mappedOffsets.push(source);
      }
      continue;
    }

    ch = PUNCTUATION.get(ch) ?? ch;
    // NFKC after the explicit tables above, not before: NFKC already decomposes
    // the ligatures, but doing it here would lose the chance to attribute each
    // expanded character, and it does *not* touch the curly quotes, which need
    // the table regardless.
    const normalised = ch.normalize("NFKC");
    for (const expanded of normalised) {
      mapped.push(expanded);
      mappedOffsets.push(source);
    }
  }

  // Step 6 — collapse whitespace runs to one space, and trim. A run is
  // attributed to its first character, so a quote starting at a collapsed run
  // resolves to where the whitespace began.
  const text: string[] = [];
  const offsets: SourceOffset[] = [];
  let inWhitespace = false;

  for (let i = 0; i < mapped.length; i++) {
    const ch = mapped[i];
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        inWhitespace = true;
        // Leading whitespace is dropped rather than emitted-then-trimmed, so
        // the offsets array never has to be re-sliced to stay aligned.
        if (text.length > 0) {
          text.push(" ");
          offsets.push(mappedOffsets[i]);
        }
      }
      continue;
    }
    inWhitespace = false;
    text.push(ch);
    offsets.push(mappedOffsets[i]);
  }

  // Trailing space, if the page ended mid-run.
  if (text.length > 0 && text[text.length - 1] === " ") {
    text.pop();
    offsets.pop();
  }

  return { text: text.join(""), offsets };
}

// Whether two adjacent items need a separator between them, and which.
// Compares bounding boxes in text space, which is stable under zoom and
// rotation — a comparison in CSS pixels would be neither (docs/PDF.md §5).
function separatorBetween(previous: PdfTextItemLike, next: PdfTextItemLike): string | null {
  if (previous.hasEOL) return "\n";

  // Font size from the matrix rather than `height`: `height` is 0 for some
  // items in practice, which would make every ratio below infinite.
  const fontSize = Math.hypot(previous.transform[2] ?? 0, previous.transform[3] ?? 0) || previous.height || 1;

  const previousY = previous.transform[5] ?? 0;
  const nextY = next.transform[5] ?? 0;
  if (Math.abs(nextY - previousY) > fontSize * LINE_BREAK_RATIO) return "\n";

  // Already ends (or starts) with whitespace — inserting another would produce
  // a double space that step 6 collapses anyway, but attributing a character
  // nobody needs is wasted provenance.
  if (/\s$/.test(previous.str) || /^\s/.test(next.str)) return null;
  if (previous.str.length === 0 || next.str.length === 0) return null;

  const previousEndX = (previous.transform[4] ?? 0) + previous.width;
  const nextX = next.transform[4] ?? 0;
  return nextX - previousEndX > fontSize * SPACE_GAP_RATIO ? " " : null;
}
