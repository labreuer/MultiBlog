# Anchoring comments and annotations

How a remark stays attached to the passage it is about, while the passage moves.

This codebase answers that question **four different ways**, on four different surfaces, and
the differences are deliberate rather than accidental. This file is where the mechanisms and
their trade-offs live; PLAN.md keeps the chronology and the build order and points here.

- [The problem](#the-problem)
- [The design space](#the-design-space)
- Present strategies: [post comments](#1-post-comments--stored-offsets-remapped-on-publish) ·
  [doc annotations](#2-doc-annotations--a-mark-inside-the-ydoc) ·
  [doc links](#3-doc-links--an-external-blob-repaired-by-search) ·
  [the in-progress selection](#4-the-in-progress-selection--offsets-plus-a-re-resolve)
- Not built: [relative positions](#5-yjs-relative-positions) ·
  [awareness-carried anchors](#6-anchors-carried-in-the-awareness-channel) ·
  [scrub-state anchoring](#7-anchoring-to-a-scrub-reachable-state) ·
  [what the update log makes possible](#8-what-the-full-ydoc_update-history-makes-possible)
- [Comparison](#comparison) · [Choosing](#choosing)

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

**Surface:** `/doc/[slug]` and the doc editor. **Code:** `src/lib/annotation-extension.ts`,
`server/ydoc-hooks.ts`'s `handleApplyAnnotationMark`, `src/lib/annotation-data.ts`.
**Design:** PLAN.md §12h, §12i.

A doc has no revisions and no publish step, so there is no snapshot to hold offsets against and
no moment at which to remap them. The anchor is therefore **content**: an `annotation` mark
carrying the root annotation's id, living in the doc's own Yjs document. `Annotation` has no
anchor columns at all.

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

**The mark is applied server-side.** `submitAnnotation` inserts the row first, then asks the
collab process to apply a mark carrying that id over the requested range. Three things follow
from that ordering and placement:

- **A reader can annotate without a writable connection.** Applying a mark is an edit, which a
  `readOnly` connection cannot make. The alternative is handing every reader a writable socket
  and trusting the UI not to let them type.
- **The failure mode is the degraded state, not a corrupt one.** Row first, mark second: if the
  mark never lands, the annotation is document-level, which is a state the system already
  renders. Mark-first would leave a mark naming a row that does not exist.
- **The client never mints the id it marks with**, so it cannot mark text with someone else's
  annotation id.

**Capture, and the one place it can miss.** From the reading view the selection is captured
against the cached render, which the live document may have moved past. The request therefore
carries the selected text alongside the offsets, and the server verifies `textBetween(from, to)`
against it before marking; on a mismatch it falls back to a unique occurrence of that text in
the live document, and failing that the annotation is created document-level. The selected text
is a **request field only, never a column** — once the mark is placed, the document is the
record of what was annotated.

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

---

# Strategies not built

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

**This is already running in this codebase**, for carets. `y-prosemirror` encodes each awareness
cursor as `absolutePositionToRelativePosition(...)`, which bottoms out in
`Y.createRelativePositionFromTypeIndex` (`node_modules/y-prosemirror/dist/y-prosemirror.cjs`
:362, :1426). Nothing about a collaborator's caret is stored in the document; it points *at* the
document's internal CRDT identity, which is exactly what an offset and a text search cannot do.

**Why it was rejected for annotation anchors, and why that does not settle the question.**
[§12h's GC decision](#why-gc-true-and-what-it-rules-out) rules it out for a **persisted** anchor:
a durable relative position needs `gc: false`, and a living document would accumulate a tombstone
per deletion forever. That reasoning is sound and still holds. It does **not** transfer to a
selection that lives for seconds in one client's memory: the GC hazard requires the anchored item
to be deleted *and* collected, and if the reader's selected text was deleted, closing the
composer is the correct outcome anyway.

**The prerequisite, which is the actual work.** The reading view pushes remote content in with
`setContent(…, { emitUpdate: false })` — a wholesale document replace — so `tr.mapping` is
discarded on every update. Converting a ProseMirror position to a Yjs index needs y-prosemirror's
`ProsemirrorMapping`, which only exists when `ySyncPlugin` is installed, i.e. when the editor is
bound through `Collaboration`. So "keep `setContent`, just store a `RelativePosition`" is not a
cheaper middle road; it collapses into the same work. Worth writing down so it is not
re-proposed.

Binding the reading editor (`editable: false`, no `CollaborationCaret`) would make both the
pending decoration and the selection map automatically and retire `reresolve` entirely. **But
`setContent` is load-bearing:** `DocScrubBar` pushes historical bodies into that same editor, and
you cannot do that into a `Collaboration`-bound editor without writing history into the live
shared document. Decoupling the scrub preview onto its own editor instance is step one, not an
afterthought. (PLAN.md §12g's "no remote carets for a reader" becomes true by omission rather
than by construction — a documentation change, not a behavioural one.)

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

The strongest available option, and mostly unexploited. Two invariants make it real (PLAN.md
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
  changed*. **Caveat, and it is a real gap:** `ydoc_update` has **no `user_id` column** —
  attribution lives in the Yjs `clientID` inside the update bytes, and nothing persists a
  clientID → user mapping. The `authorHighlight` marks in the document are a separate, already-
  present attribution channel that does carry a real user id; whether to join the two, or add a
  column, is unresolved.
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

---

## Comparison

| | Anchor lives | Survives edit *before* | Survives edit *inside* | Needs collab server | Durable | Per-resolution cost |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Post comments | Columns, vs. an immutable snapshot | Yes (remapped on publish) | Detaches | No | Yes | Zero at read; one diff per publish |
| 2. Doc annotations | Mark in the ydoc | Yes (it *is* the content) | Yes | Yes, to apply | Yes | Zero |
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
   and be suspicious of any argument to leave the document.
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
(pending selection), §14a/§14d (doc links) · [docs/PERMISSIONS.md](PERMISSIONS.md) for who may
annotate what.
