import type { PdfTarget, Quad } from "./pdf-anchor";
import { onePassage, resolveAll, skeletonOf, type Skeleton, type TextRange } from "./pdf-fragment";
import { carryRange } from "./pdf-quote-carry";
import { applyFit, fitIsClose, fitIsIdentity, fitSheets, sharedWordEnds, type MeasuredSheet } from "./pdf-sheet-fit";

// docs/PDF.md §13, "Placing each anchor" — where an anchor on one version of
// a file would go on a later one. The rules start from where the anchor is
// now: its target on its own version, and the *mapped sheet*, its sheet's
// counterpart through every page map between the two versions, where it has
// one.
//
// The answer is one of three. **Placed**: the anchor places itself, and a
// bulk carry moves it. **Proposal**: a person's acceptance makes it a move.
// **None**: a person places the note by hand, or leaves it. A suggestion to
// a note's author shows whichever came out.
//
// Pure: it takes text and measured sheets and opens nothing. What reads them
// is `src/lib/file-anchor-placements.ts`.

/** A sheet's text with its skeleton, made once for however many quotes are looked for on it. */
export type SheetText = { text: string; skeleton: Skeleton };

export function sheetTextOf(text: string): SheetText {
  return { text, skeleton: skeletonOf(text) };
}

/** One place a quote stands on a sheet, and whether what stands around it there is what stood around it before. */
export type Occurrence = { range: TextRange; agrees: boolean };

/** The first skeleton index whose character starts at or after `offset`. */
function skeletonIndexAt(sk: Skeleton, offset: number): number {
  let low = 0;
  let high = sk.starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sk.starts[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Every place a quote stands on a sheet, by skeleton, in order and counted
 * apart, as a fragment link's passage is found: on a word boundary at each
 * end. A quote that began or ended inside a word is found by none of these,
 * and is carried by the diff of the two sheets (`placeQuote`'s third rule),
 * which keeps its place inside a word both sheets share.
 *
 * **An occurrence agrees** with the quote's `prefix` and `suffix` when the
 * text before it ends in the prefix's skeleton and the text after it begins
 * with the suffix's. An empty one agrees with anything. A prefix is 32
 * characters cut wherever they fall, so neither is held to a word boundary.
 */
export function quoteOccurrences(sheet: SheetText, quote: PdfTarget["quote"]): Occurrence[] {
  const prefix = skeletonOf(quote.prefix).text;
  const suffix = skeletonOf(quote.suffix).text;
  const sk = sheet.skeleton;
  return resolveAll(sheet.text, onePassage(quote.exact), sk).map((range) => {
    const at = skeletonIndexAt(sk, range.start);
    const after = skeletonIndexAt(sk, range.end);
    return {
      range,
      agrees: sk.text.slice(Math.max(0, at - prefix.length), at) === prefix && sk.text.slice(after, after + suffix.length) === suffix,
    };
  });
}

/** How a quote's place was found: on its mapped sheet, once in the whole version, or carried through a correction of its words. */
export type QuoteFound = "sheet" | "version" | "corrected";

export type QuotePlacement =
  | {
      kind: "placed" | "proposal";
      /** 0-based, on the later version. */
      sheet: number;
      range: TextRange;
      how: QuoteFound;
      /** For "corrected": the share of the quote's letters that changed. */
      changed?: number;
    }
  | { kind: "none"; why: "not-found" | "several" };

/**
 * Where a quote on one version is on a later one.
 *
 * **It places itself** by the first of these that holds:
 *
 * 1. it is found once on the mapped sheet. Of several occurrences there, the
 *    one that agrees with its `prefix` and `suffix` is the quote, where
 *    exactly one does;
 * 2. it is found exactly once in the whole version, and that occurrence
 *    agrees. This holds on whatever sheet, and so for an anchor whose sheet
 *    has no counterpart. A quote with neither a prefix nor a suffix, the
 *    whole of its sheet's text, has nothing to agree with and is a proposal;
 * 3. its words were corrected on the mapped sheet: it is not there, and its
 *    old range comes through a diff of the two sheets' text cleanly
 *    (`carryRange`).
 *
 * **It has a proposal** where the diff carried the range less cleanly, where
 * it is found once in the version without agreeing, or where it is found
 * several times in the version and exactly one occurrence agrees. The diff's
 * comes first: it is on the sheet the map says the quote was on.
 *
 * Otherwise **it has no place**: not found, or found more than once. A quote
 * that now crosses a break between sheets is on neither sheet whole, and so
 * is not found.
 *
 * `earlierText` is the anchor's own sheet at the text version its offsets
 * are into, or null where that text is no longer stored; the third rule is
 * then not tried.
 */
export function placeQuote(
  anchor: { quote: PdfTarget["quote"]; position: TextRange },
  earlierText: string | null,
  later: readonly SheetText[],
  mappedSheet: number | null,
): QuotePlacement {
  const mapped = mappedSheet !== null && mappedSheet >= 0 && mappedSheet < later.length ? mappedSheet : null;
  const onMapped = mapped !== null ? quoteOccurrences(later[mapped], anchor.quote) : [];

  if (mapped !== null && onMapped.length > 0) {
    const chosen = onMapped.length === 1 ? onMapped : onMapped.filter((occurrence) => occurrence.agrees);
    if (chosen.length === 1) return { kind: "placed", sheet: mapped, range: chosen[0].range, how: "sheet" };
  }

  const everywhere = later.flatMap((sheet, index) => (index === mapped ? onMapped : quoteOccurrences(sheet, anchor.quote)).map((occurrence) => ({ sheet: index, ...occurrence })));
  const hasContext = skeletonOf(anchor.quote.prefix).text !== "" || skeletonOf(anchor.quote.suffix).text !== "";
  if (everywhere.length === 1 && everywhere[0].agrees && hasContext) {
    return { kind: "placed", sheet: everywhere[0].sheet, range: everywhere[0].range, how: "version" };
  }

  // Tried only where the quote is not on the mapped sheet, and only from
  // text the offsets are really into.
  const { start, end } = anchor.position;
  const carried =
    mapped !== null && onMapped.length === 0 && earlierText !== null && earlierText.slice(start, end) === anchor.quote.exact
      ? carryRange(earlierText, later[mapped].text, anchor.position)
      : null;
  if (mapped !== null && carried && carried.kind !== "none") {
    return { kind: carried.kind, sheet: mapped, range: carried.range, how: "corrected", changed: carried.changed };
  }

  if (everywhere.length === 1) return { kind: "proposal", sheet: everywhere[0].sheet, range: everywhere[0].range, how: "version" };
  const agreeing = everywhere.filter((occurrence) => occurrence.agrees);
  if (everywhere.length > 1 && agreeing.length === 1) {
    return { kind: "proposal", sheet: agreeing[0].sheet, range: agreeing[0].range, how: "version" };
  }
  return { kind: "none", why: everywhere.length > 1 ? "several" : "not-found" };
}

/** A sheet as a rectangle is placed against it: its page box (`[x0, y0, x1, y1]`), its rotation, and its text as the quads are measured from it. */
export type SheetGeometry = { box: readonly number[]; rotation: number; measured: MeasuredSheet };

/** How a rectangle's place was found: the ink has not moved, a fit of the shared words carried it, or neither sheet says and the page box is the same. */
export type QuadsFound = "unmoved" | "fitted" | "no-text";

export type QuadsPlacement = { kind: "placed" | "proposal"; quads: Quad[]; how: QuadsFound } | { kind: "none"; why: "no-fit" | "other-box" };

/** Two page boxes are the same within this, in points: what a number written "612.00" and one written "612" differ by is nothing, and no rebuilt book kept its box to a point. */
const SAME_BOX_WITHIN = 0.01;

function sameBox(a: SheetGeometry, b: SheetGeometry): boolean {
  return a.rotation === b.rotation && a.box.length === 4 && b.box.length === 4 && a.box.every((edge, index) => Math.abs(edge - b.box[index]) <= SAME_BOX_WITHIN);
}

/**
 * Where a target with no words is on its mapped sheet: a rectangle
 * selection, or a text selection whose quote its capture dropped.
 *
 * - **It places itself, its quads unchanged**, where the two sheets have the
 *   same page box and rotation and a transform fitted to the words they
 *   share is the identity (`fitIsIdentity`).
 * - **A proposal**: its quads carried by that transform, where the fit is
 *   close (`fitIsClose`); or unchanged on a sheet with no text, where the
 *   box and rotation agree. Nothing on such a sheet says whether the ink
 *   sits where it did.
 * - **No place**: the transform doesn't fit, which is also where two sheets
 *   with text share fewer than two words; or a sheet has no text and the
 *   box differs.
 */
export function placeQuads(quads: readonly Quad[], earlier: SheetGeometry, later: SheetGeometry): QuadsPlacement {
  const same = sameBox(earlier, later);
  const wordless = (sheet: SheetGeometry) => skeletonOf(sheet.measured.text).text === "";
  if (wordless(earlier) || wordless(later)) {
    return same ? { kind: "proposal", quads: quads.map((quad) => [...quad] as Quad), how: "no-text" } : { kind: "none", why: "other-box" };
  }
  const ends = sharedWordEnds(earlier.measured, later.measured);
  const fit = fitSheets(ends.from, ends.to);
  if (!fit) return { kind: "none", why: "no-fit" };
  if (same && fitIsIdentity(fit, later.box)) return { kind: "placed", quads: quads.map((quad) => [...quad] as Quad), how: "unmoved" };
  if (!fitIsClose(fit)) return { kind: "none", why: "no-fit" };
  const carried = quads.map((quad) => {
    const moved: number[] = [];
    for (let corner = 0; corner < 8; corner += 2) moved.push(...applyFit(fit, [quad[corner], quad[corner + 1]]));
    return moved as Quad;
  });
  return { kind: "proposal", quads: carried, how: "fitted" };
}
