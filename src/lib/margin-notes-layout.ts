// The geometry half of margin notes (PLAN.md §18) — a comment or annotation
// card sitting level with the passage it is anchored to, rather than in a
// list below the article. Pure and DOM-free on purpose: everything that
// *measures* lives in components/margin-notes/use-margin-notes.ts, and
// everything that *decides* lives here, so the packing rule can be reasoned
// about (and eventually tested) without a browser.

// Vertical breathing room between two cards the packer had to stack because
// their anchors were too close together to give each its own row.
export const MARGIN_NOTE_GAP = 12;

// The one place the wide/narrow threshold is written for JS. The CSS side
// (each page's own `.layout`) uses the identical string in a `@media` block,
// deliberately mobile-first so the two can be compared literally rather than
// as a value and its off-by-one complement — a `max-width: 1179px` mirror
// would be the same rule spelled differently, which is exactly how the two
// drift apart later. 1180px is the fourth documented width alongside
// STYLE.md's 680/800/1040 — an 800px reading column plus the 2.5rem gap plus
// a 340px rail — and the threshold *is* that width, so the rail engages
// exactly when its layout fits rather than at a round number above it. It was
// 1200px until an iPad measured 1194 in landscape (PLAN.md §18): six pixels
// short of a threshold whose layout had twenty to spare.
export const MARGIN_NOTES_MEDIA_QUERY = "(min-width: 1180px)";

// The doc editor's second answer to the same question, and the only surface
// with one. A phone held sideways has room *across* for the rail and almost
// none down the page, which is the opposite of what the width threshold above
// asks about: at 844×390 the rail fits beside the editor perfectly well, and
// 1180px says no because it is reasoning about a desktop window.
//
// Written as short-and-wide rather than as "is this a phone", because height
// is what the mode actually reacts to — the point of it is that vertical
// space is scarce enough to be worth spending the site header on.
// `max-height: 500px` clears every phone in landscape (the tallest is around
// 430 CSS px) and excludes every iPad, whose landscape height is 834. It
// therefore also catches a desktop window dragged unusually short, which is
// deliberate: the trade it makes is about available height, and a 400px-tall
// window has the same problem a phone does.
export const EDITOR_FOCUS_MEDIA_QUERY = "(orientation: landscape) and (max-height: 500px)";

// What the doc editor's rail gates on: either the desktop width or the
// phone-landscape mode. A comma is `or` in a media query list and matchMedia
// parses one exactly as CSS does, so this stays a single string with a
// character-identical mirror in DocEditor.module.css — the same discipline
// the threshold above documents, applied to a list rather than one feature.
//
// Only this surface gets it. The reading views keep MARGIN_NOTES_MEDIA_QUERY
// alone, because their rail costs 340px of a *reading column* rather than of
// an editor whose width is already elastic: at 844px wide the post page would
// be asking a phone to read prose in 464 pixels.
export const EDITOR_MARGIN_NOTES_MEDIA_QUERY = `${MARGIN_NOTES_MEDIA_QUERY}, ${EDITOR_FOCUS_MEDIA_QUERY}`;

export type MarginNoteMeasurement = {
  id: string;
  // Where this card wants its top edge, in the coordinate space of whatever
  // container it is positioned within. `null` means "this card has no live
  // anchor" — a general-discussion thread, a DETACHED comment thread, or an
  // annotation whose mark is no longer in the document (PLAN.md §12h) — and
  // sends it to the end of the rail rather than dropping it.
  targetTop: number | null;
  height: number;
};

export type MarginNotePlacement = { id: string; top: number };

export type MarginNoteLayout = {
  placements: MarginNotePlacement[];
  // Total height the container needs so the last card isn't clipped. The
  // caller writes this to the container's own `height`, since absolutely
  // positioned children contribute nothing to it.
  height: number;
};

// Greedy top-down packing: sort by where each card *wants* to be, then walk
// down placing each one at the lower of its own wish and the bottom of the
// one before it. That gives exact alignment wherever there's room and a
// stable, order-preserving cascade wherever there isn't — no card ever
// appears above one whose anchor is earlier in the document, which matters
// more than any individual card's precision.
//
// Anchorless cards (targetTop null) sort after every anchored one and keep
// their input order among themselves, so the rail reads as "everything
// anchored, in document order, then everything that isn't".
export type PackMarginNotesOptions = {
  gap?: number;
  /**
   * Floor for the cascade, and therefore for the first card's placement.
   *
   * `0` — the default, and what the doc rail wants — keeps a card anchored
   * above the container's own top edge (an early quote, with the rail's heading
   * and form above it) from being placed at a negative offset.
   *
   * The PDF panel passes `-Infinity` instead, because there the container's top
   * edge is the *viewport's* top edge and a card above it is not misplaced, it
   * is arriving: it sits clipped above the panel, or under the panel's own
   * chrome, and slides into view as its passage scrolls down. Clamping it to 0
   * is exactly what made a card appear at full height in a single frame.
   *
   * **A negative `minTop` and an anchorless card do not mix.** A `targetTop` of
   * null falls back to 0 rather than to the cursor, so the first such card in
   * the cascade lands at 0 — the container's top — however far below that the
   * anchored cards sit. That is harmless at the default `minTop`, where 0 is
   * the floor anyway, and is why the PDF hook never passes a null `targetTop`:
   * an annotation with no on-screen target is not in its rail at all.
   */
  minTop?: number;
};

export function packMarginNotes(
  notes: MarginNoteMeasurement[],
  { gap = MARGIN_NOTE_GAP, minTop = 0 }: PackMarginNotesOptions = {},
): MarginNoteLayout {
  const anchored = notes
    .filter((note) => note.targetTop !== null)
    // Array.prototype.sort is stable, and `filter` preserves input order, so
    // two cards anchored to the same position keep the order the caller
    // rendered them in.
    .sort((a, b) => a.targetTop! - b.targetTop!);
  const floating = notes.filter((note) => note.targetTop === null);

  const placements: MarginNotePlacement[] = [];
  // Doubles as the clamp described on `minTop`.
  let cursor = minTop;

  for (const note of [...anchored, ...floating]) {
    const top = Math.max(note.targetTop ?? 0, cursor);
    placements.push({ id: note.id, top });
    cursor = top + note.height + gap;
  }

  return { placements, height: placements.length === 0 ? 0 : cursor - gap };
}
