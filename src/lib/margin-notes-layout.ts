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
// as a value and its off-by-one complement — a `max-width: 1199px` mirror
// would be the same rule spelled differently, which is exactly how the two
// drift apart later. 1200px is a fourth documented width alongside STYLE.md's
// 680/800/1040: an 800px reading column plus a 340px rail plus the gap.
export const MARGIN_NOTES_MEDIA_QUERY = "(min-width: 1200px)";

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
export function packMarginNotes(
  notes: MarginNoteMeasurement[],
  gap: number = MARGIN_NOTE_GAP,
): MarginNoteLayout {
  const anchored = notes
    .filter((note) => note.targetTop !== null)
    // Array.prototype.sort is stable, and `filter` preserves input order, so
    // two cards anchored to the same position keep the order the caller
    // rendered them in.
    .sort((a, b) => a.targetTop! - b.targetTop!);
  const floating = notes.filter((note) => note.targetTop === null);

  const placements: MarginNotePlacement[] = [];
  // Doubles as the clamp that keeps a card anchored above the container's own
  // top edge (an early quote, with the rail's heading and form above it) from
  // being placed at a negative offset.
  let cursor = 0;

  for (const note of [...anchored, ...floating]) {
    const top = Math.max(note.targetTop ?? 0, cursor);
    placements.push({ id: note.id, top });
    cursor = top + note.height + gap;
  }

  return { placements, height: placements.length === 0 ? 0 : cursor - gap };
}
