# Margin notes — comment and annotation cards beside the text they belong to

**Status: built.** The reading views' rails since 2026-08-12 (PLAN.md §18); the doc
editor's rail and its phone-landscape queue since August (§18c); the PDF viewer's rail with
the file surface (§19, 2026-08-24); the rail's width a range rather than a number since
2026-09-17. This file is the as-built account, per the house convention; the plan's text is
in PLAN.md's git history. Composing an annotation *from* the editor, which §18f described,
is docs/ANNOTATIONS.md ("Composing from the doc editor"); what a card is anchored *to* is
docs/COMMENTS.md and docs/ANNOTATIONS.md; the anchoring theory is docs/COLLAB.md.

## What a margin note is

A comment thread and an annotation both know which passage they belong to, and both used
to spend that knowledge on a quoted-text header at the top of a list below the article,
leaving the reader to hold the mapping across a scroll. Above 1180px there is room not to
ask: each card that can point at something is drawn level with its own passage, in a rail
to the right of the text.

**Only the anchored cards move.** `CommentSection` and `AnnotationSection` stay exactly
where they were, below the article, and keep everything that is not a placeable card — the
heading, the form or composer, the own-drafts list, the sort control, and every entry with
no live anchor: a general-discussion thread, a `DETACHED` comment thread, an annotation
whose mark is gone. The rail is not the section relocated; it is a second destination for
the subset of cards that can point at something, so the authoring surface stays where a
reader knows to look and the rail never has chrome of its own competing with the article.

Below the breakpoint nothing changes: one stacked list, same order, same markup minus a
couple of wrapper divs. It is a reflow breakpoint in STYLE.md's sense, not an overflow fix.

## CSS owns the grid, JS owns the vertical alignment

Where a passage lands on screen depends on its content and the viewport, so it cannot be
declared, only measured — `editor.view.coordsAtPos()` against a live editor, which every
reading surface already mounts for its selection popover. The split that follows: **the
two-column grid is CSS and is server-rendered in the right place from first paint; only
each card's `top` waits for hydration.** `useMediaQuery`'s server snapshot is a hard
`false`, so anything more in JS would mean the whole rail popping into place after
hydration rather than merely settling. Don't move the column layout into JS to simplify.

Three modules, deliberately separable:

- **`src/lib/margin-notes-layout.ts`** — the packing rule alone, pure and DOM-free
  (`packMarginNotes`). Sort by where each card wants to be, then walk down placing each at
  the lower of its own wish and the previous card's bottom, with `MARGIN_NOTE_GAP` between
  stacked cards. Exact alignment wherever there is room, a stable cascade wherever there is
  not, and one invariant worth more than any card's precision: **no card ever appears above
  one whose anchor is earlier in the document.** Anchorless cards sort last in input order;
  the reading surfaces no longer send them, the editor's rail relies on it.
- **`src/components/margin-notes/use-margin-notes-layout.ts`** — the measuring and the
  triggers. Positions are written straight to `element.style`, never held in React state:
  they depend on post-paint measurements and the doc surfaces re-measure on every remote
  keystroke, so a render per measurement would be the wrong shape (`pseudo-border.ts` set
  the precedent). Recompute triggers: the editor mounting, `window.resize`, a
  `ResizeObserver` on the container, on every card and on the editor's own DOM node (a card
  growing when a reply composer opens; the article reflowing on a late font), the editor's
  `update` event, and the context's channel — all through one `requestAnimationFrame` gate.
- **`src/components/margin-notes/margin-notes-context.tsx`** — carries the article's
  *editor* (only it knows where a quote landed) and the rail's *DOM node* across subtrees
  that are siblings under the page, the same problem `DocPresenceProvider` solves for
  awareness. Its change channel is a listener set, not a state counter: bumping state on
  every remote keystroke would re-render the article and every card to move cards that are
  moved imperatively anyway.

**The anchored cards are portaled, not re-rendered elsewhere.** `CommentEntryList` and
`AnnotationList` still own every entry — sort order, the permalink `hashchange` effect, the
tree — and `createPortal` moves the DOM of the anchored subset into the rail without moving
that ownership. Two sibling components would have forked all three and lifted the sort
state into a third place. `pseudo-border.ts` gained multi-root support for the same reason:
a card can sit in either column, so the bar resolves
`closest("[data-comment-section], [data-pseudo-border-root]")` and appends there.

**Which ids are anchored is the one thing that goes through React state**, because it
decides what renders *where* rather than merely where it sits. `onAnchoredIdsChange` fires
only when the resolved set actually changes, never on the per-keystroke passes that find the
same set, so the common case costs no renders. That state is **seeded from data, not from
zero** — a post comment from `anchorFrom !== null && status === "ACTIVE"`, an annotation
from `quotedText !== ""` — so SSR and the first client render agree and the first anchored
render is already right in the common case, instead of flinging half the list across the
page a frame later. Seeding is all those values are trusted for; the live scan then
overrides them.

**The degradation is deliberate.** The `.anchored` class is toggled from JS, never from a
`@media` block, so a page whose script fails renders the plain stacked list rather than a
pile of cards at the container's origin.

## The threshold and the width

`MARGIN_NOTES_MEDIA_QUERY` (`src/lib/margin-notes-layout.ts`) is `(min-width: 1180px)`,
the one place JS writes the threshold; each page's own `.layout` uses the identical string
in a mobile-first `@media` block, so the two can be compared literally rather than as a
value and its off-by-one complement. **1180 is a composed width** — the 800px reading
column plus the 2.5rem gap plus the rail's 340px floor — and moves when the layout does,
so it is never a round number to round off. It was 1200 until an iPad measured 1194 in
landscape, six pixels short of a threshold whose layout had twenty to spare.

**The rail's width is a range, not a number**: `clamp(340px, calc(100% - 800px - 2.5rem),
680px)` on all three reading surfaces, so it takes whatever the window has past the reading
measure and tops out at twice its floor. Pure CSS — JS asks only whether there *is* a rail,
and the hook re-packs off the `resize` listener and per-card `ResizeObserver` it already
had, since a wider card that re-wraps is just a shorter one. **Never a `minmax()`**: grid's
free-space distribution fills the smaller track first and would hand the rail its full
680px at the breakpoint itself, leaving the prose 428px. STYLE.md's centred-column widths
hold the arithmetic, the container paddings, and why the reading column measures 768px or
776px at the breakpoint exactly.

The doc editor matches a second clause besides the threshold — `(orientation: landscape)
and (max-height: 500px)`, phone landscape — where the rail is a queue rather than aligned
("The doc editor's rail") and keeps the 340px floor, having no passage to align with.

## Resolving "where is this anchored"

This is the one place the post and doc sides cannot share code, and the asymmetry is old.

- **A post comment** has stored offsets into an immutable published snapshot: a card's
  position is `coordsAtPos(anchorFrom)` — `from`, not `to`, so the card lines up with where
  the quote starts.
- **A doc annotation** is resolved against the live document, two ways at once: a
  mark-anchored one has no stored offset and is *found* by scanning the document's marks; a
  column-anchored one has offsets into a document that has kept moving, tracked per
  transaction rather than trusted. `resolveAnnotationRanges` (`src/lib/annotation-marks.ts`)
  merges both into one id → range map, and nothing in the layout knows there are two.

Scanning the live document rather than trusting the server matters: the server decides
quoted-vs-general against `Doc.proseJson`, a store-debounce snapshot stale by seconds while
anyone types — fine for whether to draw a quote header, wrong for which paragraph a card sits
beside. Reading the editor means a card follows its text as an author edits above it.
`DocReadingBody` needs one wire the post page does not: remote content arrives via
`setContent(…, { emitUpdate: false })`, so the editor's own `update` never fires, and
`onContentPushed` reports to the layout alongside re-resolving the pending selection.

An entry whose anchor cannot be resolved is simply absent from the map, which is exactly the
signal that keeps it in the section below. The sort control stays visible and keeps working:
it orders the section, and a control that disappears on a viewport change would be worse
than one whose effect is partial.

## The doc editor's rail

`EditorAnnotationRail` gives an author revising a passage what has been said about it
without leaving for the reading view. Three deliberate differences from the reading rails:

- **Presently-anchored only, and nothing below.** No general bucket, no card for an
  annotation whose mark is gone, and no stacked list under the editor at any width — below
  the breakpoint it renders nothing. The editing view answers "what is attached to the text
  in front of me", and an annotation with no mark has no answer there.
- **Interactive.** Reply, Edit and Delete work from the editor as from the reading view;
  `AnnotationNode`'s `readOnly` prop is gone, this rail having been its only caller.
- **A window, not a list.** The doc body scrolls inside its own frame
  (`EditorChrome.module.css`'s `.editorContent`, marked `data-editor-scroll`), so a card's
  offset is not invariant under scroll. The hook's `bounds` option — its only caller — makes
  cards track the internal scroll and hides one whose anchor has left the frame rather than
  pinning it to an edge. `DocEditor`'s container is a flex row for this, with the column
  behaviour moved to `.mainColumn` so `.editorFrame` still has a definite height to grow into.

**In phone-landscape focus mode the same rail is a queue**: every annotation the doc has, in
document order, anchorless ones last, in normal flow inside a column that scrolls on its own.
A margin is right for reading; a queue is right for revising — an author working through
annotations needs to see that there are twelve rather than the two beside the viewport, to
read a long note without the document moving, and to keep their place on every keystroke.
On a phone held sideways the passage and its card are inches apart anyway. What replaces
alignment is a **marker, not navigation**: a card whose passage is inside the editor's
visible band carries `data-on-screen` and the queue colours its left border, always present
so that nothing shifts when the colour changes. Tapping a passage to scroll its card was
declined — in an editor a tap places a caret. Three consequences: the hook's `positioned`
option (it still *measures*, and marks instead of placing) and a second boolean, `live`,
beside `anchored`; the anchorless pre-filter moved out of the page and into the rail, since a
server component cannot know which presentation is on screen; and DOM order became
load-bearing in one mode, so the queue sorts by resolved anchor and commits to state only
when the order changes.

## The PDF rail

`/pdf/[slug]`'s Annotations pane positions cards through `use-pdf-margin-notes.ts`, a
sibling of the layout hook rather than a generalisation of it: the PDF surface shares none of
the parts that make the hook complicated (no TipTap editor, no `coordsAtPos`, no per-keystroke
re-resolution, no portal, pdfjs events rather than transactions), so the plan's pluggable
source would have touched the context, the hook and all three consumers to serve a fourth
surface. What the two share is the packing rule, and `packMarginNotes` is imported unchanged.
The pane's "Rail" mode holds only the cards whose passages are on screen, level with them;
"All" lists everything in page order. Out of the rail means `display: none`, never unmounted,
because a card can hold an open reply composer.

## Prepared, not built

`collectAnnotationMarkRanges` answers "which annotations are presently anchored, and where"
against the live document — the input a doc-side equivalent of the post side's
remap-on-publish would need. Nothing consumes it that way: an annotation whose mark is gone
degrades to document-level per render, and no status is written. It is a shared module so
that when something does consume it there is one definition of "presently anchored" rather
than three. Two things a future phase decides: who writes and when (every reader's browser
has the map, and N clients persisting a correction is last-writer-wins on the field whose job
is precision; the doc editor's rail is the natural writer), and whether a mark that reappears
un-detaches (undo exists, so derived-and-cached beats a latched one-way transition).

## Known gaps

- **The split happens after hydration**, so a wide viewport paints the whole list in the
  section once and then lifts the anchored cards out. No way around it without knowing the
  viewport server-side; the same views already swap a static body for an editor on `ready`,
  and the split is gated on the same flag so the two settle together.
- **An entry moving between the rail and the section remounts its subtree**, discarding an
  open reply composer or a delete confirmation on that card. Reachable only when an author's
  edit removes or restores the marked text while a reader has that card open; rendering both
  destinations and hiding one would duplicate every permalink id.
- **The reading-view rail does not scroll independently.** A document with one comment near
  the end leaves a tall empty column; sticky positioning would fix that and break the
  many-cards case.
- **Coverage.** `margin-rail-widths.spec.ts` asserts the breakpoint from both sides, the
  width range, the editor's rail appearing and vanishing, and the whole of the phone-landscape
  queue (chrome dropped, sideways scroll, the marker, the ordering, the on-screen colouring,
  no page scroll). `packMarginNotes` itself, pure by design, has no unit test.

## Deviations from the plan

- **1200px became 1180px**, the composed width, after the iPad measurement.
- **The rail's width became a range** (2026-09-17), which the plan had as a fixed 340px.
- **The editor's cards are interactive**, where §18c planned them read-only.
- **The phone-landscape queue** was not planned; it arrived with STYLE.md's fourth
  breakpoint.
- **The PDF rail is a sibling hook**, not the generalised source §19's Phase 3 proposed.

## History

- **2026-08-12** — the reading views' rails (PLAN.md §18).
- **August 2026** — the doc editor's rail, then interactive, then the queue (§18c).
- **2026-08-24** — the PDF viewer's rail (§19).
- **2026-09-17** — `clamp(340px, …, 680px)`.
