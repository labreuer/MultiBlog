# Anchoring comments and annotations

How a remark stays attached to the passage it is about, while the passage moves.

This codebase answers that question **six different ways**, and the differences are deliberate
rather than accidental. Note that the count is of *mechanisms*, not surfaces: doc annotations
alone use two, picked by which surface an annotation was written on rather than by who wrote
it — §2 and §2b, and the reason for the split is a security argument rather than an anchoring
one. This file is where the mechanisms and their trade-offs live; PLAN.md keeps the chronology
and the build order and points here.

- [The problem](#the-problem)
- [The design space](#the-design-space)
- Present strategies: [post comments](#1-post-comments--stored-offsets-remapped-on-publish) ·
  [doc annotations, from the editor](#2-doc-annotations--a-mark-inside-the-ydoc) ·
  [doc annotations, from a reading view](#2b-doc-annotations-from-a-reading-view--offsets-against-a-stamped-update) ·
  [doc links](#3-doc-links--an-external-blob-repaired-by-search) ·
  [the in-progress selection, reading view](#4-the-in-progress-selection--offsets-plus-a-re-resolve) ·
  [the in-progress selection, doc editor](#5-yjs-relative-positions)
- Not built: [awareness-carried anchors](#6-anchors-carried-in-the-awareness-channel) ·
  [scrub-state anchoring](#7-anchoring-to-a-scrub-reachable-state) (partly built as §2b) ·
  [what the update log makes possible](#8-what-the-full-ydoc_update-history-makes-possible)
  (including [showing an annotation at its own revision](#showing-an-annotation-at-its-own-revision--built-one-way-with-a-better-one-available),
  the one part of §8 that is partly built)
- [Comparison](#comparison) · [Choosing](#choosing) · [Log](#log)

---

## The problem

A comment says something about *this sentence*. Storing which sentence is easy; keeping it
true is not. Every representation of "this sentence" is invalidated by some edit:

| You store | Broken by |
| --- | --- |
| Character offsets | Any insertion or deletion *earlier* in the document |
| The quoted text | Any edit *to that text*, and ambiguity when it occurs twice |
| A mark in the document | Nothing — but only if you may write to the document, and only within one document |
| A CRDT item reference | Deleting the referenced item (and then only once garbage-collected) |

There is no representation that survives everything, so each surface picks the failure it can
best afford. What follows is which failure each one picked, and why.

Two terms used throughout:

- **Detached / degraded** — the anchor no longer resolves. The remark is never lost; it stops
  being *located*. Every surface here keeps the remark visible and only removes the inline
  highlight.
- **Re-anchoring** — recovering a lost location, either by searching for the text again or by
  mapping the old position forward through what changed.

---

## The design space

Five axes. Almost every difference between the strategies below is a different point on one
of them.

1. **Where the anchor lives** — inside the document's own content, or outside it in a column.
   Inside means it moves with the text for free and cannot drift; outside means it can
   describe things one document cannot (a link between two docs), at the cost of drift.
2. **What names the position** — an absolute offset, the quoted text, or a CRDT item id.
   Offsets are cheap and fragile; text is robust to movement but ambiguous and defeated by
   editing; item ids are exact but die with the item.
3. **What the position is relative to** — the live document, an immutable snapshot, or a named
   historical state. A snapshot never moves, which is why the post side is easy; a living doc
   moves continuously, which is why the doc side is not.
4. **Who may write** — applying a mark is an edit. A reader who may annotate but not edit
   forces either a server-applied mark or an external anchor.
5. **When it is resolved** — once at write time, or on every render. Resolve-on-render tracks
   the document but pays per keystroke; resolve-once is free afterwards but can go stale.

One cross-cutting hazard worth stating on its own, because three different bugs have come from
it: **`Doc.proseJson` is a store-debounce cache, not the document** (PLAN.md §12d). It lags the
live ydoc by seconds whenever anyone is typing. It is fine for deciding *whether* to draw
something and wrong for deciding *where*.

---

# Present strategies

## 1. Post comments — stored offsets, remapped on publish

**Surface:** `/[slug]`, the published post. **Code:** `comment_thread` columns,
`src/lib/anchor-remap.ts`, `src/lib/quote-highlight-extension.ts`. **Design:** PLAN.md §5, §15.

A published post is an immutable snapshot, so absolute offsets into it are stable by
construction — this is the easy case, and it is easy for a reason that does not generalize.

**Creating.** The reader selects text in the published article; the client reads the
selection's ProseMirror `{from, to}` in *that publication event's* coordinates plus the plain
quoted text, and a `comment_thread` row stores `anchored_event_id`, `anchor_from`, `anchor_to`,
`quoted_text`.

**Rendering.** A ProseMirror plugin builds **decorations** — an inline highlight over each
range and a clickable count badge where threads land. Decorations are display-only, so this
never alters stored content. Nothing is re-resolved at read time; the offsets are already
correct for the snapshot being rendered.

**Surviving a new revision.** On publish, the previous and new `proseJson` are compared. The
intermediate editing steps were never captured from the reader's side, so the change set is
*reconstructed* with `@fellow/prosemirror-recreate-transform` and turned into a `Mapping`. Each
thread's endpoints are mapped through it, biased away from the range (`map(from, 1)`,
`map(to, -1)`) so text inserted exactly at a boundary is not pulled into a quote that is
supposed to be stable. If the mapped range still reads as the stored `quoted_text`, the thread
moves forward and re-anchors to the new event; otherwise it becomes `DETACHED`.

**`DETACHED` is not terminal, and once was.** The remap query covers `ACTIVE` *and* `DETACHED`.
A detached thread stays frozen at the last event it was valid against and is re-diffed from
that same frozen event on every later publish — so if the text comes back (most directly by
scrubbing back to and republishing an earlier doc state), the thread reattaches. It was
originally `ACTIVE`-only, which made detachment permanent and silent; that is PLAN.md §10 item
20, and it is the cautionary case for any "one-way degrade" in this file.

**What the reader sees.** Every thread appears in the list, active or detached; only active
ones get an inline highlight. A detached thread's "jump to quote" is meant to explain that the
passage changed and offer to show it in the context of the event it was made against.

**Cost.** One document diff per distinct source event per publish — threads are grouped by
`anchored_event_id` so a post whose threads lag several publishes behind still costs one diff
per event, not one per thread. Zero cost at read time.

## 2. Doc annotations — a mark inside the ydoc

**Surface:** the doc editor (`/doc/[slug]/edit`). **Code:** `src/lib/annotation-extension.ts`,
`server/ydoc-hooks.ts`'s `handleApplyAnnotationMark`, `src/lib/annotation-data.ts`.
**Design:** PLAN.md §12h, §12i, §13o.

> **This is now one of two mechanisms on the same model, and no longer the one a *reader*
> gets.** Annotating from either reading view stores offsets instead —
> [§2b](#2b-doc-annotations-from-a-reading-view--offsets-against-a-stamped-update), below,
> which exists because applying a mark is an edit and a reader may not make one. Everything
> in this section is still exactly true of an annotation written from the doc editor, and
> that surface is not moving: it already holds a writable connection, so the mark costs it
> no privilege it lacks, and a mark cannot drift. `Annotation.anchor_from` being null *is*
> "this one is anchored by a mark."

A doc has no revisions and no publish step, so there is no snapshot to hold offsets against and
no moment at which to remap them. The anchor is therefore **content**: an `annotation` mark
carrying the root annotation's id, living in the doc's own Yjs document.

Because the anchor *is* part of the document, it moves with its text automatically, merges
correctly under concurrent editing, and cannot drift. There is nothing to re-resolve, ever.

Two schema details it depends on:

- **`excludes: ""`** — ProseMirror's default is that a mark type excludes its own type, which
  would make a second annotation over overlapping text *replace* the first. Empty `excludes`
  lets several instances with different `id` attrs coexist; ProseMirror splits the run into
  segments carrying the right subsets. (The `data-thread-ids`-plural handling in
  `quote-highlight-extension.ts` exists because overlapping *decorations* cannot do this. Marks
  can.)
- **`clearable: false`** — otherwise the editor's "clear formatting" button strips anchors
  along with real formatting. The anchor is content, but it is not the user's formatting.

**The mark is applied server-side.** `postAnnotation` inserts the row first, then asks the
collab process to apply a mark carrying that id over the requested range. Three things follow
from that ordering and placement:

- **A reader could annotate without a writable connection.** Applying a mark is an edit, which
  a `readOnly` connection cannot make; routing it through the collab process meant a reader
  never needed a writable socket. **This is the part that did not survive** — see §2b. It
  worked; what it cost was that a reader's annotation was a real, unattributed, unbounded write
  into a document they were explicitly denied write access to.
- **The failure mode is the degraded state, not a corrupt one.** Row first, mark second: if the
  mark never lands, the annotation is document-level, which is a state the system already
  renders. Mark-first would leave a mark naming a row that does not exist. One consequence of
  that ordering is easy to miss and was a real bug: the mark lands in an update *after* the state
  its author was looking at, so that state can never show it — see
  [showing an annotation at its own revision](#showing-an-annotation-at-its-own-revision--built-one-way-with-a-better-one-available).
- **The client never mints the id it marks with**, so it cannot mark text with someone else's
  annotation id.

**Capture, and the one place it can miss.** The selection is captured against the client's
render, which the live document may have moved past. The request therefore carries the selected
text alongside the offsets, and the server verifies `textBetween(from, to)` against it before
marking; on a mismatch it falls back to a unique occurrence of that text in the live document,
and failing that the annotation is created document-level. That rule is
`resolveAnchorInDoc` (`src/lib/annotation-anchors.ts`), shared with §2b rather than restated,
so the two mechanisms cannot come to disagree about what "this quote is still here" means. The
selected text is a **request field only, never a column** — once the mark is placed, the
document is the record of what was annotated. (§2b keeps that rule true of the trust boundary
even though it does have a column: what it stores is the *server's* reading, never the
client's.)

**Document-level-ness is derived, not stored.** `collectMarkAttrValues(proseJson, "annotation",
"id")` is one pass over JSON the reading view already holds; a root annotation whose id is not
in that set renders in general discussion instead of the margin. There is no stored status to
get stuck, so §5's `DETACHED`-is-terminal bug class is structurally impossible here.

**Losing the mark degrades; it does not delete.** Delete the annotated text and the mark goes
with it. The `annotation` row still has its `doc_id`, so it becomes a document-level comment on
that doc, and what it was about is whatever its body says. **It is one-way**: retyping the same
words does not restore the mark. Re-marking is an edit somebody has to make — see
[§8](#8-what-the-full-ydoc_update-history-makes-possible) for what the update log would make
possible here.

### Why `gc: true`, and what it rules out

`gc: true` everywhere, server and client — the Yjs default, set explicitly in §11d's
`yDocOptions`. Garbage collection is the one Yjs setting an annotation design can be wrecked
by, so the choice is recorded as a decision rather than left to look like an accident.

**It costs nothing here, because the anchor is content.** The design GC *would* break is
anchoring by `Y.RelativePosition`, which names an item id:
`createAbsolutePositionFromRelativePosition` returns `null` once that item has been collected
into a `GC` struct rather than surviving as a tombstone, so keeping such an anchor resolvable
means `gc: false`. A mark is not a pointer into the document, it *is* the document, so it moves
with its text and is collected only when that text is. GC never strands it.

**It buys a document that does not grow forever.** `gc: false` means a tombstone per deletion
for the life of the document. A post could afford that — its life is punctuated by revisions. A
living document's whole premise is that it never is, so the entity that most needs bounded
growth is exactly the one that would pay most for turning GC off.

**Never flip `gc` for a doc that has already loaded with it on.** One load with GC on collects
tombstones permanently, so any future `gc: false` experiment is one-way per document and has to
be a new-docs-only decision, not a config change.

## 2b. Doc annotations from a reading view — offsets against a stamped update

**Surface:** `/doc/[slug]` — both the doc itself and, since PLAN.md §13p, the body of any
posted annotation on it. **Code:** `Annotation.anchor_from`/`anchor_to`/`quoted_text`,
`src/lib/annotation-anchor-capture.ts`, `src/lib/annotation-highlight-extension.ts`.
**Design:** PLAN.md §13o, §13p. **This is [§7](#7-anchoring-to-a-scrub-reachable-state) built**
— its columns and its version stamp, though not yet its materialize-and-diff resolver.

Same model, same surface family, opposite side of §2's central trade. §2 buys "cannot drift" by
making the anchor content; the price is that creating one is a **write**. For a reader that
price turned out to be too high, for reasons that are about the write itself rather than about
anchoring:

- The write is **unattributed** — `attributeUpdate` reads identity off the Hocuspocus
  connection, and a direct connection has none, so it lands in the never-truncated
  `ydoc_update` log with no author.
- The write is **unbounded** — `excludes: ""` (§2, deliberately) permits any number of
  overlapping marks, each `addMark` splits text runs, and `removeMark` does not merge them
  back. Annotation volume from people with read access is a permanent structural growth path
  into a document they cannot otherwise write to.
- It keeps a **mark-anything endpoint** on the hot path for every reader.

So a reading-view annotation stores `{anchor_from, anchor_to, quoted_text}` and touches the
document not at all. Which mechanism applies is decided by **surface, not permission**: an
author reading `/doc/[slug]` gets the column anchor too. Keying on permission would put two
anchor kinds behind one identical gesture.

**The version stamp is what makes stored offsets defensible here.** `ydoc_update_id` was
already on the row as metadata (§13n); it is now the coordinate system the offsets are
expressed in, exactly as `anchored_event_id` is for a post comment — with the update log as the
axis in place of discrete publication events, which is [§7](#7-anchoring-to-a-scrub-reachable-state)'s
whole observation. `captureAnnotationAnchor` materializes the stamped state, resolves the
client's offsets against **that**, and stores its own `textBetween` at the result. Two
properties fall out:

- **Nothing a client says is stored verbatim.** Its `quoted_text` is a verification hint only.
  Name text that isn't in the stamped state and you get no anchor — not an anchor of your
  choosing. (Name text that *is* there and you get an annotation on that passage, which is
  indistinguishable from having selected it.)
- **The triple is verifiable forever.** Replay to `ydoc_update_id` and `textBetween(from, to)`
  *is* `quoted_text`, by construction. Resolving against "now" would have described a state
  nothing records — and would have left §7's repair path with nothing trustworthy to diff from.

This needs no collab round trip, which is worth stating because the obvious objection is
staleness: `ydocOnChange` appends a `ydoc_update` row **per Yjs update**, not per store
debounce, so the log's tail is within a websocket round trip of live. That is a different
guarantee from `Doc.proseJson`, and the distinction is the cross-cutting hazard at the top of
this file.

**Resolution at read time is tiered**, because the naive version is unaffordable — this is the
one place §2's "there is nothing to re-resolve, ever" is paid back in full. Ranges live in
`AnnotationHighlight`'s plugin state and update per transaction:

1. **Map through the transaction**, biased away from the range, then verify against
   `quoted_text` (a mapping says where positions went, not whether the words survived). Free,
   and correct for every local edit in the doc editor.
2. **Search a window** sized by the document's own size delta. The reading views push remote
   updates in with `setContent`, so there is no usable mapping ([§4](#4-the-in-progress-selection--offsets-plus-a-re-resolve)'s
   trap) — but the text has barely moved, so a keystroke elsewhere costs a few dozen probes
   rather than a scan. A window hit is *more* trustworthy than a globally unique match: it is
   the occurrence nearest where the anchor already was.
3. **A full scan, once.** Failing that the anchor is detached and is not rescanned on later
   transactions — that would be O(document × quote) per keystroke forever, for the annotation
   least likely to repay it. Detachment is re-evaluated on the next anchor push, the doc-side
   equivalent of §1 re-testing a `DETACHED` thread at the next publish rather than continuously.

Without tier 2 this would be the first per-keystroke full scan on a reading surface. Doc links
([§3](#3-doc-links--an-external-blob-repaired-by-search)) pay that cost and memoize on document
identity — worthless here, since every remote update *is* a new document.

**No repair writes from a reading view**, per §3's closing rule. The doc editor could
legitimately persist a correction and does not yet; that is where §7's repair half belongs.

**Detachment keeps its quote, unlike §2.** A lost mark leaves nothing behind. A stored quote
survives, because it was derived against a reconstructible state — so the card keeps its
blockquote and can still say what it was about. That is §1's `DETACHED` affordance, on the doc
side, which the mark could never offer.

**One answer for both.** `resolveAnnotationRanges` (`src/lib/annotation-marks.ts`) merges the
mark scan and this plugin's ranges; every consumer goes through it. The visible seam is in the
DOM: a mark renders `data-annotation-id` (singular), a decoration renders
`data-annotation-ids` (plural, because overlapping inline decorations drop each other's
attributes — the same split §1's `data-thread-ids` already has).

### The same mechanism, pointed at an annotation

**Design:** PLAN.md §13p. A reply anchors to a passage of the annotation it answers, using
these columns unchanged — the only thing that differs is which ydoc they are offsets into
(`ydoc:annotation:<parentId>` rather than `ydoc:<docId>`), and therefore which update log
stamps them. Worth reading as a property of this mechanism rather than as a fourth strategy:
nothing in the resolver, the decoration layer or the click handler knew or needed to know which
document it was pointed at.

Three things about it are specific rather than incidental:

- **The target is decided by the row, not the request.** `parent_annotation_id` non-null picks
  the parent's ydoc; null picks the doc's. There is no combination of arguments a client can
  send that produces a reply anchored into the doc, or a root anchored into an annotation.
- **A mark was never an option here**, whatever the write permissions —
  `annotationContentExtensions` has no `annotation` mark in it (PLAN.md §13a), on purpose, so
  an annotation body cannot carry an anchor onto another annotation.
- **The anchored body is immutable in practice and not by construction.** There is no UI for
  editing a posted annotation, which is why offsets into one behave like §1's offsets into a
  snapshot rather than like §2b's into a living doc. But `canUserAccessAnnotationYdoc` grants a
  writable connection to any doc reader, so that is a missing feature rather than a guarantee —
  don't build anything that assumes those offsets can never move. The version stamp is what
  would resolve it when they do.

## 3. Doc links — an external blob, repaired by search

**Surface:** `/side-by-side/[left]/[right]`. **Code:** `src/lib/doc-link-anchor.ts`,
`DocLink.mark`. **Design:** PLAN.md §14a, §14b, §14d.

A doc link joins a selection in one doc to a selection in another, and **deliberately reverses
§12i's central choice** — its anchor is a JSON blob in Postgres, not a mark. The reason is
structural, not taste:

- **A mark lives in exactly one document; a link joins two.** The mark design needs two marks
  in two different ydocs, which immediately invents a failure mode neither annotations nor
  quotes have: the half-applied pair, where one side landed and the other did not. There is no
  transaction spanning two Yjs documents to close that window.
- **Applying a mark is a write.** Side-by-side explicitly serves readers who may be unable to
  edit either doc. The server-applied-mark trick from §12i would work, and would couple doc
  links to a running collab server on day one, for a feature whose entire state is otherwise
  ordinary rows.

The price is drift, and §14d is that price paid in full.

**The stored anchor** is `{ v: 1, from, to, text, before, after, blocks }` — offsets, the quoted
text, up to 50 characters of context on each side to break ties, and how many block nodes the
selection spanned. `v` exists because this is the one column whose shape changes if the inline
`mark_id` path ever lands. Every read goes through `parseDocLinkMark`, never a cast.

**Resolution runs per link, per content change**, cheapest first:

1. `to <= doc.content.size && textBetween(from, to) === mark.text` → use the stored offsets.
   O(1), and the overwhelmingly common case.
2. Otherwise `findQuoteOccurrences(doc, mark.text)`. Exactly one → use it. Several → filter by
   `before`/`after` and use the survivor if exactly one remains. Zero, or still ambiguous →
   **unanchored**.
3. Memoize on `(doc identity, links identity)`.

Step 3 is load-bearing, not an optimization: the read column calls `setContent` on every
incoming update — every remote keystroke — and `findQuoteOccurrences` is O(doc × text) with no
index. Fifty links across two docs without memoization is a full scan per link per keystroke.
Neither annotations nor post comments ever hit this shape; both re-find at most once, on submit.

**A selection spanning more than one block skips step 2 entirely** (`mark.blocks > 1`) and
degrades straight to unanchored, because `findQuoteOccurrences` cannot match across a block
boundary: a paragraph break costs more than one ProseMirror position but contributes one
separator character, so the sliding `from + len` window undercounts once per boundary. Readers
comparing two documents absolutely do select across paragraphs, so this is a real limitation
rather than a corner. See [the note on the reverted fix](#a-rejected-fix-worth-not-repeating).

**Persisting a corrected offset happens only from a column in write mode** — and is not built,
because the write column's highlighting was never wired up. The reasoning is what matters and
generalizes: a write column is bound through `Collaboration`, so its corrected positions come
from real ProseMirror transactions and are authoritative. A read column is a tap that is always
at least one update behind, so any offset it computes was already stale when computed, and
persisting it would be N concurrent readers last-writer-wins on the one field whose entire job
is precision.

## 4. The in-progress selection — offsets plus a re-resolve

**Surface:** the reading view, while a composer is open. **Code:**
`src/lib/use-selection-popover.ts`, `src/lib/pending-annotation-extension.ts`. **Design:**
PLAN.md §13f.

Not a durable anchor at all — this is the few seconds between selecting text and submitting,
and it is included because it is where the anchoring problem is most visible to a user and
where the current answer is weakest.

Selecting text loses the browser's native highlight the moment focus moves into the annotation
editor, so the range is drawn as a **decoration** — not a mark. Decorations are not content,
never sync, and never touch the ydoc.

**The trap:** the reading view's live tap calls `setContent` on every incoming update, which
rebuilds the document and discards every decoration along with it, *and* discards ProseMirror's
own `tr.mapping` — the mechanism that makes this problem disappear on the editor surface. So
each `setContent` re-resolves the pending range: verify `textBetween(from, to)` still equals the
captured text; on a mismatch fall back to a unique-occurrence search; failing that, drop it.

The consequences are worth stating plainly, because they are the sharpest edge in this file:

- An edit **after** the selection is harmless.
- An edit **before** the selection shifts the absolute offsets, so every re-resolution falls to
  the text search even though nothing about the selection moved.
- The search keeps the selection **only if the quoted text occurs exactly once in the whole
  document**. The more ordinary the phrase, the likelier someone typing in an earlier paragraph
  closes a composer being typed into.
- A selection spanning a paragraph break can never be recovered, per the block-boundary
  limitation above.

### A rejected fix worth not repeating

`findQuoteOccurrences` was rewritten (2026-08-12) to flatten the document once, keep each
character's own range, and map a string match back to positions — which fixed block boundaries,
made it O(document), and let `reresolve` re-anchor to the *nearest* occurrence rather than
demanding a unique one. It was reverted the same day as **too brittle**.

The reason is worth keeping: it replaced a search that *borrowed* `textBetween`'s own separator
handling with one that *reimplemented* it, so it had to reproduce that behaviour exactly rather
than approximately. A property test over every real selectable range caught two separate
block-boundary mistakes before it passed — a fair signal about how many more lived in document
shapes the test did not enumerate — and every caller downstream depends on
`textBetween(from, to) === quotedText` holding for the ranges returned. Buying a better failure
mode for a transient selection is not worth resting that invariant on a hand-rolled mirror of
prosemirror-model internals.

The direction that does not have this problem is [§5](#5-yjs-relative-positions): stop naming
the position with text at all.

## 5. Yjs relative positions

**What it is.** `Y.RelativePosition` names a specific CRDT item — which client inserted this run
of characters, at what clock — plus an association, instead of an integer. Yjs item ids are
permanent and the sequence is a total order over items, so the reference never needs remapping:

- **Insert before it** — same item, different computed index; the index is recomputed on read
  via `relativePositionToAbsolutePosition`. Nothing to map.
- **Insert *inside* the range** — each endpoint is anchored to its own item, neither of which
  moved. The range simply contains more. This is the property that looks impossible from
  outside, and it is why a remote collaborator's selection survives edits within it.
- **Delete the anchored item** — it becomes a tombstone and the position still resolves to where
  the tombstone sits, until GC collects it.

**This was already running in this codebase**, for carets, before any of the below — `y-prosemirror`
encodes each awareness cursor as `absolutePositionToRelativePosition(...)`, which bottoms out in
`Y.createRelativePositionFromTypeIndex` (`node_modules/y-prosemirror/dist/y-prosemirror.cjs`
:362, :1426). Nothing about a collaborator's caret is stored in the document; it points *at* the
document's internal CRDT identity, which is exactly what an offset and a text search cannot do.

**Built (PLAN.md §18, doc editor selection widget) for the *transient* case — the persisted-anchor
rejection below is unchanged.** `src/lib/yjs-relative-anchor.ts` is this codebase's first
app-level `Y.RelativePosition` code (everything above ran entirely inside y-prosemirror's own
internals). `captureRelativeRange`/`resolveRelativeRange` back the doc editor's own
selection-to-annotation widget (`use-editor-annotation-widget.ts`, `CollabEditorBody.tsx`): the
selection is captured as a relative range the instant it's made, and resolved fresh against the
live document both on every remote/local transaction (for repositioning the widget) and again at
submit time (for the mark actually applied) — no text-search fallback, and, per the CRDT
property above, correct even when a collaborator edits *inside* the selected range while the
composer sits open, which no offset-based scheme in this file can do.

**Why it was rejected for a *persisted* annotation anchor, and why that still holds.**
[§12h's GC decision](#why-gc-true-and-what-it-rules-out) rules it out for a **persisted** anchor:
a durable relative position needs `gc: false`, and a living document would accumulate a tombstone
per deletion forever. That reasoning is sound and still holds — the doc editor's own widget never
serializes a `RelativeRange` anywhere, exactly because of it (see the file's own header comment).
It does **not** transfer to a selection that lives for seconds in one client's memory: the GC
hazard requires the anchored item to be deleted *and* collected, and if the reader's selected
text was deleted, closing the composer is the correct outcome anyway.

**The prerequisite, and why it splits the two reading surfaces from the editor.** Converting a
ProseMirror position to a Yjs index needs y-prosemirror's `ProsemirrorMapping`, which only exists
when `ySyncPlugin` is installed, i.e. when the editor is bound through `Collaboration`. The doc
*editor* (`CollabEditorBody.tsx`) is — hence the widget above. **Neither reading view is.** Both
push remote content in with `setContent(…, { emitUpdate: false })` — a wholesale document replace
— which discards ProseMirror's own `tr.mapping` on every update, so "keep `setContent`, just
store a `RelativePosition`" is not a cheaper middle road there; it collapses into the same work
§4's `reresolve` already does. Worth stating plainly so it is not re-proposed for either reading
surface as a small patch.

Binding the reading editor (`editable: false`, no `CollaborationCaret`) would make both the
pending decoration and the selection map automatically and retire `reresolve` entirely — still
not done, still blocked on the same conflict: **`setContent` is load-bearing there.**
`DocScrubBar` pushes historical bodies into that same editor, and you cannot do that into a
`Collaboration`-bound editor without writing history into the live shared document. Decoupling
the scrub preview onto its own editor instance is step one, not an afterthought. (PLAN.md §12g's
"no remote carets for a reader" becomes true by omission rather than by construction — a
documentation change, not a behavioural one.)

---

# Strategies not built

## 6. Anchors carried in the awareness channel

Not documented anywhere else, and worth separating from §5 because the two are usually conflated:
**relative positions are an *encoding*; awareness is a *transport and a lifetime*.** They are
orthogonal, and most useful together.

**What awareness is.** A per-client key/value map (y-protocols, surfaced as
`provider.awareness`) replicated to every peer and **dropped automatically on disconnect or
timeout**. It is not part of the document, is never persisted, and never enters `ydoc_update`.

**What this codebase already uses it for.** Two things, neither of which carries an anchor:
`CollaborationCaret` (cursor positions — which *are* relative positions), and
`DocPresenceProvider` / `AnnotationPresenceIndicator` (PLAN.md §13i, "who is currently composing
an annotation"). Note the second already establishes the plumbing: the reading view's read-only
connection exposes its awareness object to the annotation tree, and every composer publishes into
that one channel keyed by its own client id. A read-only connection's awareness flows freely —
only document *content* updates are gated — so a reader who cannot edit can still publish here.

**The strategy.** Publish the pending or draft anchor itself into awareness, as a relative
position, alongside the presence flag that is already there. Four things fall out:

- **The anchor maps for free**, for the reasons in §5 — including edits inside the range.
- **The pending range becomes visible to everyone.** Today's `PendingAnnotation` decoration is
  local-only, so an author editing a paragraph has no idea a reader is mid-annotation on it.
  This is the only option in this file that makes in-progress anchoring *collaborative* rather
  than merely durable, and it is the reason to reach for it.
- **Cleanup is free and correct.** An abandoned composer leaves nothing behind — no `DRAFT` row
  to sweep, no stale anchor. Compare PLAN.md §13d's "Keep private" drafts, which persist
  deliberately and are the exception rather than the rule.
- **The server can read it too.** Hocuspocus exposes awareness server-side, so the collab process
  could observe pending anchors — enough to warn an editor, or to let the eventual
  mark-application call resolve a relative position exactly instead of re-verifying offsets
  against text (§12i's "the one place it can miss").

**Limits, and one of them is a security limit.**

- **Ephemeral by construction.** Awareness can only ever anchor in-progress things. The moment an
  annotation is committed it needs a durable anchor — a mark, or one of §7/§8. This is not a
  replacement for strategies 1–3; it is a replacement for strategy 4.
- **Untrusted.** Awareness is client-authored and unvalidated: a client can publish any anchor,
  including one naming another user. It is fine as a *hint* and must not become the authority
  for applying a mark — §12i's "the client never mints the id it marks with" still governs.
- **Broadcast cost.** Every state change goes to every peer. An anchor is small; the quoted text
  it refers to is not, and does not belong here.
- **Timeout semantics.** A client that goes quiet without disconnecting has its state expire
  (30s by default). Good for cleanup, bad if treated as durable — a slow composer must refresh
  its own state.

## 7. Anchoring to a scrub-reachable state

> **Half of this is now built, as [§2b](#2b-doc-annotations-from-a-reading-view--offsets-against-a-stamped-update).**
> The columns and the version stamp exist and are written on every reading-view annotation,
> and `quoted_text` is derived against the stamped state precisely so that the resolver
> described below stays buildable. What is **not** built is that resolver: nothing
> materializes-and-diffs to place an anchor. §2b resolves against the *live* document with a
> text search, which is cheaper and weaker. The rest of this section is therefore still the
> design for the remaining half — and "a second source of truth", below, stopped being
> hypothetical: the two mechanisms coexist, and `resolveAnnotationRanges` is the reconciliation
> it warned would be needed.

The doc-side analogue of §5's remap-on-publish, using the ydoc update log as the version axis in
place of discrete publication events.

**The observation.** The post side is easy because a comment names an *immutable* document
(`anchored_event_id`) and offsets into it. Docs were assumed to have no such thing — but they do.
`DocScrubBar` already lets a reader move a doc to any past state, and `materializeYdocAt(ydocId,
throughUpdateId)` already reconstructs one server-side. A `ydoc_update.id` is a perfectly good
version coordinate; it is just continuous where a publication event is discrete.

**The shape.** `Annotation` gains `anchored_update_id BIGINT`, `anchor_from`, `anchor_to`,
`quoted_text` — precisely `comment_thread`'s columns, with the update log as the axis.
Resolution: materialize the doc at `anchored_update_id`, diff it against the target state, map
the endpoints through, exactly as `anchor-remap.ts` does today.

**What it buys that a mark cannot.**

- **An anchor for a state that is not the live one.** A mark answers "where is this now"; it
  cannot answer "where was this then". A reader scrubbed back to last Tuesday currently sees
  annotations positioned by a mark that has since moved — or vanished. A version-stamped anchor
  is resolvable *at any state*, which is the only way annotations can be correct on the scrub
  view at all.
- **Annotating a historical state.** Today the scrub view is read-only with respect to
  annotation. With a version-stamped anchor, "annotate this passage as it was" is expressible.
- **Detachment becomes recoverable rather than one-way.** See §8.
- **No write to the document.** No server-applied mark, no privileged endpoint — an ordinary row,
  like a doc link, but without a doc link's drift, because the anchor names the state it was
  measured against instead of hoping the live one still matches.

**What it costs.**

- **Resolution is no longer free.** A mark is already in the content; this needs a
  materialization and a diff. Snapshots bound the replay (§11b's derivable base), but this is
  server work per resolution rather than zero work, and the reading view resolves on every
  content change.
- **`recreate-transform` is a reconstruction, not the truth.** Diffing two materialized states
  infers a plausible change set. The real operations are in the log — see §8, which is what makes
  this strategy much stronger than a straight port of §5.
- **A second source of truth.** Annotations would have both a mark *and* a version-stamped
  anchor, or would drop the mark and lose the "cannot drift" property that is §12i's whole
  point. Picking one is the actual design decision, and running both means reconciling them.

## 8. What the full `ydoc_update` history makes possible

The strongest available option, and still mostly unexploited — one corner of it is now built, and
[has its own subsection below](#showing-an-annotation-at-its-own-revision--built-one-way-with-a-better-one-available).
Two invariants make it real (PLAN.md
§11b): **row #1 of `ydoc_update` for a document is a full state and every later row is a plain
delta**, and **the log is never truncated**. So every state a document has ever been in is
reconstructible, and the *operations* between any two states are on disk — not inferred.

**Yjs item ids are global across the whole history.** This is the fact everything below rests
on. A relative position created against a *materialized past state* names the same item as it
would in the live document, because both share one CRDT item space. That converts "remap through
history" into something much cheaper than a diff:

1. Materialize the doc at `anchored_update_id`.
2. Convert the stored offsets into a `Y.RelativePosition` **against that historical state**.
3. Resolve that relative position against the **live** document.

No `recreate-transform`, no text search, no reconstruction of a change set that already exists.
The anchor is stored as plain offsets (which are exact in their own coordinates and need no
special client support to capture) and upgraded to a CRDT reference lazily, at read time. This is
the piece that makes §7 attractive rather than merely symmetrical with §5.

**GC cuts less than it appears to.** Garbage collection affects a *doc instance*, not the log:
`gc: true` collects deleted items in the live document, but `ydoc_update` still holds every
original operation. Two consequences:

- **Historical materialization is unaffected.** Text that existed at state T is present when you
  materialize T, deleted-since or not — it was not deleted *yet* at T. Reading the past does not
  need `gc: false`.
- **Only live resolution is affected.** Step 3 above returns null when the anchored item has been
  deleted *and* collected — which is precisely the "the passage is gone" case, where detaching is
  the correct answer. The failure mode coincides with the semantics.

**What becomes answerable that is not today:**

- **"What did this annotation cover?", after its mark is gone.** Materialize the state at the last
  update where the mark existed and read the range. §12h already notes this is a real path and
  defers it; the doc-side equivalent of the post side's "show the quote in the context of the
  revision it was made against".
- **"When, exactly, did it detach?"** Binary search over `ydoc_update.id`, materializing at each
  probe, to find the first state where the quote stopped matching. O(log n) materializations, run
  on demand only.
- **"Who changed it?"** Yjs items carry a `clientID` and `ydoc_update` rows carry `created_at`, so
  a detach notice could say *Alice edited this passage 10 minutes ago* rather than *the text
  changed*. The clientID → user mapping this needs already exists — see
  [Attribution](#attribution-and-why-ydoc_update-has-no-user_id) below.
- **Un-detaching.** Because detachment could be *derived* from the log rather than latched, an
  author who deletes an annotated sentence and immediately undoes it need not have cost the
  annotation its anchor. This is the same lesson as §5's `DETACHED`-as-terminal bug, reached from
  the other direction: prefer derived-and-cached over a one-way transition.

**Costs and limits, honestly.**

- **Materialization is the expense.** Replay is from the nearest snapshot forward, so the
  snapshot cadence bounds it; with no snapshots it is O(all updates). Anything doing this per
  render needs a cache, and the cache key is the pair (state, target).
- **A snapshot base has already lost its tombstones.** Full-fidelity reconstruction — including
  items deleted before the snapshot — requires replaying from row #1 into a `gc: false` scratch
  doc. Only forensic questions need that; reading text at a past state does not.
- **This is server-side work.** The client cannot materialize history without fetching it. That
  is fine for repair and forensics, and wrong for per-keystroke resolution — which argues for
  keeping a cheap live anchor (a mark) *and* a version-stamped one for repair, rather than
  replacing one with the other.

### Showing an annotation at its own revision — built one way, with a better one available

**A mark-anchored annotation can never be attached at the state its author was looking at**, and
this is structural rather than a race. The reader sees state *S*, posts, and the collab server
applies the mark as its **own update** afterwards (§2's row-first-mark-second ordering, which is
deliberate). So *S* is the one revision guaranteed *not* to contain the mark.

That was a live bug, not a nicety: `AnnotationNode`'s "at this revision" control stamped *S*, so
clicking it scrubbed the reading view to a document with no such mark in it, and the card fell
out of the margin rail on arrival. Measured on a real doc — at update 64951 (an annotation's own
stamp) the document carried four annotation marks and not that annotation's; its own first
appears at 65049.

**What is built: stamp the update that carries the mark.** `postAnnotation` re-stamps after a
successful `applyAnnotationMark`, so `Annotation.ydoc_update_id` means the same thing for both
mechanisms — *the earliest revision at which this annotation is locatable*. Column-anchored, that
is the version its author saw, because the offsets are true there (§2b). Mark-anchored, it is the
mark's own update. `scripts/backfill-mark-annotation-stamps.ts` fixed existing rows;
`check-annotation-anchors.ts`'s `mark-at-stamp` is the standing guard.

The cost is that "this revision" now means *the revision the annotation became attached at*,
which can be far later than what its author saw. For one real annotation the gap was **74
updates** of unrelated editing — so the control answers "where is this attached" rather than
"what were they looking at", and those are different questions.

**What is available: isolate the mark's update and replay only it.** Materialize at the stamp the
author saw, then apply *only* the one `ydoc_update` row carrying the mark — nothing else from the
intervening history. That shows the revision they saw **plus exactly the mark**, which is what
the control was reaching for.

It works, and the surprising part is how well. Applying a mark update onto a state 74 updates
older integrated cleanly — mark present, nothing left in `pendingStructs`. Tested across every
mark-anchored annotation on a real doc: 5/5, including that 74-row gap.

The reason is [§8's opening fact](#8-what-the-full-ydoc_update-history-makes-possible): the mark
update's structs are format markers whose **origins are items in the annotated text**, and that
text necessarily existed at the stamp — the reader selected it there. Yjs does not need the
intervening history; it needs the *referents*, which are older than the stamp.

Two things it would need, neither large:

- **Knowing which row carries the mark.** Going forward, `handleApplyAnnotationMark` already
  reports it (that is what the re-stamp above consumes), so it is a column rather than a search.
  Historically it is a one-off scan for first appearance — the backfill script already does
  exactly that walk.
- **Verify and fall back.** Applying can fail if the mark's origins *postdate* the stamp, which
  the doc editor can produce: its stamp is the log tail at post time, and the tail can lag an
  author's own just-typed characters. Then the structs park in `pendingStructs` rather than
  throwing — silent, so the result has to be checked. Falling back to the plain revision is the
  current behaviour, so the degraded path is already understood.

**Not a GC hazard**, despite the reflex. The document being replayed into is a fresh
materialization of updates ≤ the stamp, so the annotated text is *alive* there rather than a
tombstone — the deletion, if any, lives in an update deliberately not applied. GC is an in-memory
`Y.Doc` operation and never rewrites stored rows. §12h's GC reasoning is about
`Y.RelativePosition`, a persisted pointer to an item id, and does not transfer to replaying a
stored update.

### Attribution, and why `ydoc_update` has no `user_id`

Three attribution channels already exist, in increasing precision:

1. **`Doc.updatedByUserId`** — "who touched it last", for a listing. PLAN.md §16o.
2. **The `clients` `Y.Map`** — a top-level `String(clientID) → userId` map kept *inside* each
   document, written server-side by `attributeUpdate` (`server/ydoc-hooks.ts`) once per client,
   from the identity `onAuthenticate` verified. This is the clientID → user mapping §8 needs.
3. **`authorHighlight` marks** — exact, per character, carried in the document itself.

**Why there is no `ydoc_update.user_id`, and why it is not the same objection as §16o's.**
`Doc.updatedByUserId`'s imprecision is **temporal**: the store hook is debounced, so several
authors' edits coalesce into one flush and it records whichever connection was last. Bounded,
documented, and the column is defined to accept it.

A per-row column would not inherit *that* — `ydoc_update` rows are appended in `onChange`, per
update, un-debounced, each with one connection's verified identity to hand. It would inherit a
**compositional** ambiguity instead, which is worse: one update's bytes can carry items authored
by several clients. `Y.parseUpdateMeta(update).from` is a *set*, and a client restoring content
from IndexedDB or reconnecting after offline work legitimately sends a state diff containing
items other clients authored. `attributeUpdate` already declines to guess when `from.size !== 1`;
a single FK column would have to pick one and be wrong — while *looking* like an audit trail, and
so inviting exactly the queries it cannot answer. It would also be a lossy cache of something the
bytes already answer exactly, and per row.

#### The `clients` map: concurrency

**It adds almost nothing to what Hocuspocus already handles, and that is structural rather than
lucky.**

- **No key contention, ever.** A key is a clientID; a clientID belongs to exactly one `Y.Doc`
  instance; only that connection's server-side write ever touches it. The classic `Y.Map` hazard
  — two writers on one key, last-write-wins silently discarding one — cannot arise.
- **The write is server-authored inside `document.transact()`** on the same Hocuspocus `Document`
  every client update lands on, so it serialises through Yjs's existing machinery. No new lock,
  no new ordering rule, no second write path.
- **A sibling root type, which is a shape already in use** — the title fragment (§3d) is the same
  pattern. TipTap's `Collaboration` binds one named fragment, so the map is invisible to the
  editor schema, and it is replicated, persisted and conflict-resolved by the identical code path
  as the text.

Four things that *are* new to this design. Three are closed; the third is not, and is the sharpest
edge here:

1. **A self-triggering loop** — writing to the doc fires `onChange`. Closed by
   `if (!connection) return`, since a server-side write has no connection. Worth knowing because
   the obvious extension (write on awareness instead of on change) would reopen it.
2. **Read-before-write across an await** — there is none: the `has` / `transact` pair is
   synchronous, and the re-check inside the transaction is belt-and-braces rather than load-bearing.
3. **Entries must never be deleted.** Nothing states this as an invariant and it is easy to
   violate. `attachIndexeddb` means a tab can hold updates authored under a *previous* `Y.Doc`'s
   clientID; a reload mints a new clientID while the old content keeps the old one. A future
   "prune stale clients" compaction would silently destroy attribution for all historical content,
   and the damage would surface only in a backfill or a forensic query, long afterwards.
4. **Ordering versus content** — a consumer materialising at exactly the update that introduced a
   client can see content whose clientID is not yet in the map. Tolerate it, don't assume it away;
   `scripts/doc/backfill-updated-by.ts` already refuses to guess rather than falling back.

Note what the map deliberately does *not* record: `attributeUpdate` only fires on a doc-changing
update, so a pure reader never gets an entry, and neither does a server-applied annotation mark.
It is "who has edited", not "who has connected".

#### The `clients` map: performance

**The hot path is free.** Steady state per update is `socketClientIds.get(socketId)` then
`clients.has(key)` — two hash lookups, then return. The write happens at most once per
(connection, document). Two costs sit slightly off that path: the fallback when awareness has not
yet been seen for a socket calls `Y.parseUpdateMeta(update)`, which is O(update size) per update
until the first awareness message arrives; and `isNewDistinctUser` is `[...clients.values()]`,
O(map size), but only on the write path.

**The real cost is the sync payload, and it is larger than it looks.** Measured (Yjs 13,
`gc: true`, a stringified clientID key and a cuid value):

| entries | map bytes | per entry |
| --- | --- | --- |
| 100 | 4.9 KB | 49 B |
| 1,000 | 49 KB | 49 B |
| 5,000 | 245 KB | 49 B |
| 20,000 | 980 KB | 49 B |

Exactly linear at **49 B per entry**. For scale, a 20,000-character body encodes to ~20 KB — so
**about 400 accumulated clientIDs already match the size of the document they attribute**, and
this rides in the `ydoc` blob every reader downloads on every cold open, and in every
`ydoc_snapshot`.

Growth is per *editing session*: a new `Y.Doc` mints a new random clientID on every reload or
reconnect, but only an editing client is ever recorded. Five authors editing three times a day
for a year is roughly 3,700 entries, about 180 KB. Overwriting a key does **not** accumulate —
measured, 5,000 overwrites of one key encode to 60 B total, because superseded values are
collected. Only distinct keys persist, which is precisely the growth axis above.

**If the payload ever matters**, the natural alternative is a Postgres table
`ydoc_client(ydoc_id, client_id, user_id, first_seen)`: same no-contention property (a unique
key), same append-only semantics, zero sync payload, at the price of a second write path. The
in-document version buys two things over it — it needs no separate write, riding a transaction
that is already happening; and it is *as of* any materialised historical state for free. The
second advantage is smaller than it sounds, because entries are immutable: "the mapping as of
update N" and "the current mapping restricted to clients present at N" are the same set. Not a
reason to move it today, but the direction to move if a long-lived document's cold open ever
starts to hurt.

---

## Comparison

| | Anchor lives | Survives edit *before* | Survives edit *inside* | Needs collab server | Durable | Per-resolution cost |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Post comments | Columns, vs. an immutable snapshot | Yes (remapped on publish) | Detaches | No | Yes | Zero at read; one diff per publish |
| 2. Doc annotations (editor) | Mark in the ydoc | Yes (it *is* the content) | Yes | Yes, to apply | Yes | Zero |
| 2b. Doc annotations (reading) | Columns + a version stamp | Yes (mapped, or re-found nearby) | Detaches | **No** | Yes | O(1) typical; windowed search on a remote update |
| 3. Doc links | JSON column | Only via text search | Unanchors | No | Yes | O(doc × text), memoized |
| 4. Pending selection | Client memory | Only if text is globally unique | No | No | No (seconds) | O(doc × text) per update |
| 5. Relative positions | CRDT item id | Yes | Yes | Yes (needs a binding) | Only with `gc: false` | O(1)-ish |
| 6. Awareness anchors | Awareness channel | Yes | Yes | Yes | No, by design | O(1)-ish |
| 7. Scrub-state anchor | Columns + a version stamp | Yes | Yes | Yes (materialize) | Yes | Materialize + diff |
| 8. Log-derived | Columns + the update log | Yes | Yes | Yes | Yes | Materialize + resolve |

## Choosing

Rules of thumb, in the order they actually decide things:

1. **Is the target immutable?** Then offsets are fine and everything else is over-engineering.
   That is strategy 1, and it is why the post side never needed any of this.
2. **Does the anchor describe exactly one document, and may the writer write to it?** Then a mark
   (strategy 2) beats everything: no drift, no resolution, no reconciliation. Reach for it first
   and be suspicious of any argument to leave the document. **Read "may the writer write to it"
   strictly**, though — it is the clause §2b was carved out of. A server-applied mark makes the
   answer technically yes for anyone, and that is exactly the trap: the write still happens, it
   is just unattributed and outside the permission that was supposed to govern it. If the person
   annotating could not have typed into that document themselves, the honest answer is no, and
   you want a version-stamped anchor (§2b/§7) instead.
3. **Is it ephemeral?** Then durability is not a requirement and awareness (strategy 6) is
   strictly better than anything stored — it also makes the state visible to collaborators, which
   nothing else here does.
4. **Does it span two documents, or must it avoid writing?** Then the anchor is external, and you
   are choosing a *repair* policy, not an anchor. Text search (strategy 3) is the weak version; a
   version stamp plus the log (strategies 7–8) is the strong one, and the log is already there.
5. **Never name a position with text if you can name it with an identity.** Strategy 4's
   fragility, doc links' ambiguity, and the reverted rewrite all trace to the same root: text
   search is a reconstruction of information the CRDT already has exactly.

**Related:** PLAN.md §5 (post anchoring), §11 (the ydoc stack), §12h/§12i (annotations), §13f
(pending selection), §13o (the mark/column split and why a reader stopped writing marks), §13p
(a reply anchored into the annotation it answers), §14a/§14d (doc links) ·
[docs/PERMISSIONS.md](PERMISSIONS.md) for who may annotate what.

---

# Log

Dated entries, appended rather than folded into the sections above — each one is a design
question asked and answered against the state of this file at the time, usually about a change
that has *not* been made. Folding them in would state as settled things that are still
proposals; deleting them would lose the reasoning that decided against, or deferred, each one.
Same convention CACHING.md and PERFORMANCE.md use.

## 2026-08-13 — What changes if annotation bodies become mutable

Asked while weighing whether to keep one read-only editor per rendered annotation (PLAN.md §13p)
or fall back to a static render plus one editor mounted on interaction. The measured cost of the
eager design is ~0.7s of added main-thread work at 30 annotations on a 4×-throttled production
build (PERFORMANCE.md's 2026-08-13 entry has the tables and the method), so the static-plus-lazy
option was the likely direction — and every argument for it rests on a posted annotation's body
being immutable, which it is only in practice.

**The question.**

> How do things change if annotations are mutable? Note that we do have
> `annotation.ydoc_update_id` and can deploy the same freeze logic — the instant some text is
> selected in an annotation, the reply is against that version and not anything which is being
> concurrently edited or edited later. The same logic which attempts to re-anchor
> annotations-on-docs can be used to re-anchor annotations-on-annotations.

**Short answer.** The re-anchoring generalizes for free — it is already literally the same code.
The freeze does less than it appears to. And the hard part is not anchoring at all.

### The re-anchoring reuse is already running, and has never executed

`AnnotationHighlight` is registered on `AnnotationBodyReader` today, three tiers and all, and it
is genuinely document-agnostic: `resolveAnchorInDoc` takes a `PMNode` and nothing in the tiering
knows whether it came from a doc or an annotation body. What is missing is not the logic but the
*input* — no live tap pushes content into an annotation body, so `tr.docChanged` never fires and
tiers 1–3 have never run on that path. Making bodies mutable would exercise existing code rather
than require new code, but it would be exercising it for the first time.

One refinement it would want. Tier 3's "one full scan, then leave the anchor detached, retry only
on the next anchor push" exists because `findQuoteOccurrences` is O(document × quote) and a doc is
large. An annotation body is 100–5000 characters, where a full scan is cheap enough to run
continuously — so the detached-is-sticky rule should be *relaxed* for annotation bodies, letting a
reply re-attach live as its parent is edited back toward what it quoted.

### Freezing the view is not freezing the anchor's coordinate system

Freezing on selection is right, for the reason [§2b](#2b-doc-annotations-from-a-reading-view--offsets-against-a-stamped-update)
and the doc reading view already have it (`frozen = scrubFrozen || selection.pending !== null`):
remote updates arrive via `setContent`, which destroys the selection outright, so without a freeze
anyone typing anywhere in the body cancels an in-progress reply.

But it does not by itself make the anchor mean what it looks like it means. Today `postAnnotation`
stamps `maxUpdateId` **at post time**, not at selection time — the client supplies its own id only
in the scrub-frozen case. So even a frozen view measures offsets against state *N* and stamps state
*N+k*. What keeps that safe is not the freeze; it is `captureAnnotationAnchor` resolving the
client's offsets against the *stamped* state and storing its own `textBetween` at the result, so
the triple ends up self-consistent with whatever it stamped no matter what drifted in between.

Getting what the question describes — the reply anchored to the version the reader actually saw —
requires capturing the stamp **at selection time**, and that needs something not currently
available client-side: `ydoc_update.id` is a server-side row id, and the doc side only ever learns
one from `DocScrubBar`'s replay index. So it is a round trip at selection time, or the id has to
ride along on the connection. Worth building, but a real addition rather than a configuration of
the existing freeze.

### Where the performance answer lands

It survives, and awareness turns out to supply the missing piece:

- Reply highlights can still be pre-split into the static render server-side for every annotation
  **nobody is currently editing**, which is nearly all of them nearly all of the time.
- An annotation under active edit needs a live editor, because its `proseJson` is a store-debounce
  cache — exactly the "fine for deciding *whether*, wrong for deciding *where*" hazard at the top
  of this file. A highlight drawn from it would sit on visibly wrong characters while someone
  types.
- PLAN.md §13i already publishes "someone is writing an annotation" onto the doc's awareness.
  That is the mount trigger: go live for the annotation under the pointer, plus any the awareness
  channel reports as being edited.

So ~1–2 live editors rather than N. Note what this does with
[§6](#6-anchors-carried-in-the-awareness-channel): it uses awareness as a transport for a *mount
decision* rather than as an anchor, which sidesteps that section's "untrusted, must not become the
authority" limit entirely — a forged or stale hint costs one unnecessary editor and nothing else.

### The genuinely harder parts, in order

1. **Permissions, not anchoring.** `canUserAccessAnnotationYdoc` already returns `canUserReadDoc`
   for any non-`DRAFT` annotation, so *anyone who can read the doc already holds a writable
   connection to anyone's annotation*. Harmless while no UI opens one; the moment bodies are
   mutable it means any reader can rewrite any annotation. Author-only, author + ADMIN, or
   genuinely collaborative is a [PERMISSIONS.md](PERMISSIONS.md) decision, and it — not the
   anchors — is the real gate on this feature.
2. **`Annotation.proseJson` joins `Doc.proseJson` as a staleness hazard.** It is a store-debounce
   cache today that happens to always be current because nobody types into a posted annotation.
   `annotation-entries.ts` renders straight from it. Every rule about never positioning off
   `Doc.proseJson` starts applying to it.
3. **The `ydoc_update_id` overload gets thinner.** It already answers "which log is my anchor
   measured against" (PLAN.md §13p). Under mutability one would plausibly also want "which doc
   revision was I reading when I replied" — two questions, one column. This is where the
   `anchor_update_id` option §13p weighed and declined deserves a second look: the argument
   against it was that the two values coincide for every root annotation, which stops being true
   here.

### The upside worth naming

An annotation body is the **best available place to build [§7](#7-anchoring-to-a-scrub-reachable-state)'s
unbuilt half**, the materialize-and-diff repair. The reason it is deferred for docs is cost:
materializing and diffing a 50k-character document per resolution is server work on every render.
Materializing a 500-character annotation ydoc is nothing. So mutable annotations would not merely
inherit the weaker text-search repair — they are the case where the strong version finally becomes
affordable, and where the version stamp already stored on every row starts earning its keep
instead of only recording intent.

## 2026-08-13 — How a client names the version it annotated against

Asked while building the change that makes `Annotation.ydoc_update_id` mean *the version the
annotator saw* rather than *the version the server resolved against* (PLAN.md §13q). The
question was mechanical and the answer turned out to be a flat no, which is worth writing down
because the alternatives all look plausible until traced.

**The question.**

> Tell me how a client which (1) loaded `prose_json` and `ydoc_update_id`, then (2) got some
> ydoc from Hocuspocus, is going to figure out precisely which `ydoc_update_id` it is at, once
> it stops applying updates (because the document/annotation is frozen, because text was
> selected).

### The timeline

| | what happens | what the client can name |
|---|---|---|
| **T0** SSR | page ships `prose_json` (content as of update **N**) and **N**; the editor is seeded with it, the `Y.Doc` is still empty | **N**, exactly |
| **T1** sync | SyncStep1 with an empty state vector, server replies with **one merged `encodeStateAsUpdate`** covering everything; `Y.Doc` jumps to head **H₁** and re-renders | nothing — no ids and no row boundaries arrived |
| **T2** live updates | each remote update is applied *and* rendered in the same synchronous handler | nothing new |
| **T3** selection | `capture()` reads `from`/`to`/`quotedText` **and** takes `Y.encodeSnapshot(Y.snapshot(ydoc))` in the same tick; the freeze begins | its exact version, as a snapshot |
| **T4** post | sends `{anchorFrom, anchorTo, quotedText, atSnapshot}` | still no id |
| **T5** server | `resolveUpdateIdForSnapshot` walks the log; `captureAnnotationAnchor` materialises there | the id, exactly |

T3 is the load-bearing step and its ordering is not incidental. Offsets and snapshot are read in
the same synchronous tick, so they describe one instant; JS being single-threaded is what
guarantees no update interleaves between them. And it has to be *then* rather than at post time,
because from T3 onward the freeze keeps applying updates to the `Y.Doc` while withholding the
render — so the document and what the reader is looking at deliberately diverge.

### Why the client cannot do better, however much it is told

- **`ydoc_update.id` is a global sequence** shared by every document, so one document's ids are
  non-contiguous. "N plus the seven updates I have seen since" is not computable client-side.
- **The sync payload is one merged update**, so even the boundary between "everything before
  sync" and "the individual updates after it" does not correspond to rows.
- **`prose_json` is content, not a version.** Re-encoding ProseMirror JSON into a `Y.Doc` mints
  fresh structs under a new client id, CRDT-incomparable with the live document — so the client
  cannot diff what it loaded against what it holds.

What it *can* do is state its version exactly in Yjs's own terms and let the server convert. That
conversion is exact for three specific reasons: per-peer clocks strictly increase within a
document's log, the delete set closes the deletion-only gap (9.5% of rows in a real corpus carry
no structs at all), and the `ydoc` row's checkpoint gives the walk a base near head.

### What the loaded `N` is actually for

Not the client. Two server-side uses:

- **The walk's base.** Writing `prose_json`, `ydoc`, `state_vector` and the update id *together*
  at the store debounce makes the `ydoc` row a rolling checkpoint never more than one debounce
  behind head. That turns the resolver's worst case from "walk the document's lifetime" into
  "walk a few seconds", and it is why opportunistic snapshotting was designed and then dropped —
  it existed to solve a problem this removes.
- **A free assertion.** The resolved id should never be **< N**: the client necessarily synced to
  at least what SSR served it.

The stamping has to stay off the hot path. `ydocOnChange` records the id its insert returns as a
side effect and never awaits it — the broadcast to peers has already happened. `onStoreDocument`,
already async and already writing, drains the per-document append queue first. Getting that
backwards stamps `prose_json` with an id *older* than the content it describes, and a consumer
replaying to that id would see less than the cache shows.

### The one window where "exact" is not available

Between a peer's keystroke and its `ydoc_update` insert resolving, every synced client holds
content that exists in **no row**, so a snapshot taken then names a state no id can. It closes on
its own — the snapshot is captured at T3 and resolved at T5, with a human typing an annotation in
between, so milliseconds of in-flight insert lose to seconds of typing.

The residual is a *failed* append (`isCircuitOpen`/`markDegraded`), where the insert never lands.
Then the client stays permanently ahead of the log, the walk consumes every row and returns the
tail, and the anchor resolves against a state missing those characters — degrading to the same
text search everything else here degrades to. Worth recognising as the persistence layer already
reporting itself degraded, rather than as anything about anchoring.

---

## A third strategy: quads into an immutable file (PLAN.md §19)

Everything above is about keeping a remark attached to a passage **while the passage moves**.
A PDF annotation is the case where it cannot.

A file's identity is the sha256 of its bytes, so the document an anchor was measured against
is, by construction, the document every later reader sees. Nothing drifts. The anchor is a
set of quadrilaterals in PDF user space (docs/PDF.md §2), and resolving it is arithmetic: a
viewport transform at the reader's current scale and rotation, and no re-resolution ever.

That makes it the cheapest strategy in this document, and it is worth being precise about
*why*, because the cheapness is not a property of quads:

- The post-comment strategy (§1) pays for an immutable snapshot with detachment across
  publishes.
- The doc-annotation strategies (§7) pay for a live document with per-transaction tracking
  and a repair story.
- The doc-link strategy (§3) pays for spanning two documents with drift on every edit.
- **This one pays nothing, because immutability was given rather than bought.**

So do not read it as evidence that quads are a better anchor than offsets or marks. Applied
to a doc, quads would be worse than either — geometry moves the instant a line rewraps. What
this strategy demonstrates is only that *when the substrate cannot change, anchoring stops
being a problem*, which is exactly the assumption none of the other three get to make.

Two consequences that do generalise:

**The quote is a check, not the anchor.** `quote.exact` and `position` exist to detect that
our own extractor or normaliser changed, not that the document did (docs/PDF.md §4's closing
note). That separation — a primary anchor plus an independent verification — is worth
copying anywhere the two can be made independent, and it is what lets a PDF annotation be
reported as `orphaned` rather than silently drawn in the wrong place.

**A version stamp measures the substrate, not the remark.** `Annotation.ydocUpdateId` is
null for every file annotation, and correctly so: it names the coordinate system an anchor
was measured in, and a file has only one. Reaching for a stamp out of habit, on a substrate
that cannot version, would be a field to keep correct for no reason.
