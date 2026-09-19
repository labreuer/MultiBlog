# Annotations — remarks on docs and PDFs, each with a body of its own

**Status: built.** The mark and the first doc-side annotations date from 2026-07-28
(PLAN.md §12i); the body became its own ydoc the next day (§13); the reading-view column
anchor, anchored replies and the version stamp followed in August (§13o, §13p, §13q); the
margin rails (§18), the doc editor's composing surface (§18f) and the PDF viewer (§19) in
August; editing a posted body on 2026-09-16 (§22e). This file is the as-built account, per
the house convention: the plans keep their reasoning about alternatives in PLAN.md, and
this file says what the code does and why, so that a reader can work on annotations
without reading §13's 815 lines first. "Deviations from the plan" below is where the two
disagree. The theory of *anchoring* — every strategy, the rejected ones, how to choose — is
docs/COLLAB.md and is not repeated here; the PDF viewer's own mechanics are docs/PDF.md.
The comment side, which shares two modules with this one, is docs/COMMENTS.md.

## What an annotation is

An `annotation` is a remark by a signed-in user on a **container** — a doc or an uploaded
file, exactly one (`docId` or `fileId`, a hand-written CHECK). A root annotation *is* the
thread: replies hang off it through `parentAnnotationId`, and there is no thread row because
nothing is left for one to own. Every annotator is a known account, since reading a doc
already requires `canViewDocs`; nothing in the commenter, spam or moderation machinery is
involved, and **an annotation is never moderated**. `userId` is `ON DELETE RESTRICT`: users
are only ever soft-deleted, so it is inert in production, and the test cleanup removes a user's
annotations before the user.

The row carries:

- **A body that is its own Yjs document**, `ydoc:annotation:<id>`, with `proseJson`,
  `bodyText` and `proseJsonUpdateId` as a cache of it ("The body is a ydoc").
- **`status`** — `DRAFT` (the author's alone, no inline mark, no presence), `LIVE` (posted),
  or `RAISED` (posted and the container's authors emailed, `raisedAt` stamped). One direction
  of travel; nothing about visibility differs between the last two.
- **An anchor**, in one of three forms picked by the surface that wrote it ("Anchoring"):
  an `annotation` mark inside the doc's ydoc and no columns; `anchorFrom`/`anchorTo`/
  `quotedText` into a document that keeps moving; or `pdfTarget`, a renderer-neutral blob
  into immutable bytes. A reply anchors into its *parent's body* with the column form.
- **`ydocUpdateId`**, the version stamp the column anchor is measured against and the
  scrub bar's "at this revision" target ("The version stamp").
- **`postedAt`**, the DRAFT → LIVE moment; **`editingSince`** and `editedAt` for a posted body
  under or after an edit. Its **versions** are `ydoc_snapshot` rows on its own ydoc, not a
  table ("Editing after posting"); `resolvedAt`, declared and never written.
- Soft-delete columns. Deleting is `requireOwnOrAdmin` and also removes the mark.

## Surfaces

- **`/doc/[slug]`**, the reading view: selecting text opens a two-stage popover — a small
  "Annotate / Move to bottom / Cancel" prompt over the selection, then the live composer —
  and `AnnotationSection` below the article holds the bottom composer, the reader's own
  drafts (`OwnDraftsList`), a sort control, a presence line, and every card that has no
  live anchor. Above 1180px the anchored cards are portalled into the margin rail beside
  their passages (docs/MARGIN_NOTES.md). Highlights are painted in each author's colour.
- **`/doc/[slug]/edit`**: `EditorAnnotationRail` shows the presently-anchored cards beside
  the editor, interactive (Reply, Edit, Delete), and nothing else — no general bucket, no
  list below. In phone-landscape focus mode the same rail is a queue in document order with
  an on-screen marker instead of alignment. Composing from here is a gutter marker beside
  the selection that opens the composer on click ("Composing from the doc editor").
- **`/pdf/[slug]`**: a side panel with an Annotations tab that is the rail — "Rail" shows
  cards level with passages on screen, "All" lists everything in page order — and
  highlights drawn on an `.annoLayer` per page. The composer speaks the file's vocabulary
  (PRIVATE / SHARED, a Save button) and offers no "notify" option; the panel has no sort
  control, since above the breakpoint it *is* the rail.
- **`/annotations`**, the admin browse table: Doc / File, Author, Body, Quote, Status,
  Created, Edited, Deleted, Raised at; gated `canManageDocs`, scoped to the containers the
  viewer may *read*, and excluding `DRAFT` outright.

## The body is a ydoc

**One ydoc per annotation, never one per doc**, because Yjs has no per-fragment ACL and
Hocuspocus's per-connection `readOnly` flag is the only enforcement point there is: "who
may edit this annotation's live text" has to be answerable per annotation. The name is
`ydocIdForAnnotation` / `annotationIdFromYdocId` in `src/lib/ydoc-names.ts`, with no foreign
key in either direction, and two guards keep the namespace from corrupting a doc's cache —
`docIdFromYdocId` returns null for an annotation's name, and `doc-cache.ts` and
`annotation-cache.ts` each branch on their own prefix.

**Readers render from a cache.** `server/annotation-cache.ts` is the store-debounce twin of
`doc-cache.ts`: it writes `proseJson`, `bodyText` and `proseJsonUpdateId` (which update of
the annotation's own log the cache is the content of) a couple of seconds after the last
keystroke; a settle (post, Done) writes the same three columns from the decoded document it
snapshots, through one shared decoder (`src/lib/annotation-body.ts`). Every list, rail and admin table renders from those columns through
`renderToReactElement` on the server (`annotation-entries.ts`, `AnnotationVersionBody`),
and a live `HocuspocusProvider` opens only for an annotation actually open in an editor. A
doc with fifty annotations opens no annotation connections until one is clicked into — and
the one it then opens is a further *document* on the page's existing websocket, not a socket
of its own (docs/YDOC.md "One socket per page"); read-only or writable is still this
annotation's token's call, whatever the doc connection beside it was granted.

**But a posted body is also a real editing surface**, `AnnotationBodyReader`: an
`editable: false` editor mounted behind the SSR copy, because a browser selection over a
static tree gives DOM offsets that would have to be converted back into document positions
by hand, and a static tree cannot carry the decorations that highlight a reply's quote inside
its parent. The cost is one editor per rendered annotation, taken deliberately over a lazy
mount whose failure mode — mounting mid selection-gesture, which cancels the gesture — is
worse.

**The schema** is `annotationContentExtensions`, which is `authorHighlightExtensions` and
nothing more: a body cannot carry the `annotation` mark, so a reply cannot anchor onto
another annotation by mark, and decoding a body with the doc schema (or the reverse) is a
real error rather than a cosmetic one. The editor's toolbar is a reduced tool list, hidden by
default behind an `Aa` toggle remembered in `localStorage`.

**The token** is `POST /api/annotation/[id]/token`, which asks two questions.
`canUserAccessAnnotationYdoc` decides whether a connection is allowed at all: a `DRAFT` is its
owner's alone, with no `ADMIN` override; anything else is readable by whoever may read the
container. `canUserEditAnnotationBody` decides `readOnly`: author or `ADMIN`, the same pair
that may delete, so an `EDITOR` who can read the doc gets a read-only connection.
`server/ydoc-hooks.ts` honours the flag, and `e2e/annotation-readonly.spec.ts` proves from
Node that a plain reader's writes are dropped. Until 2026-09-16 the route minted a writable token
for every reader — unexploited only because no UI opened one.

**Server-authored writes go through the collab process**, never to the stored blob behind
its back: `/admin/annotation-mark`, `-unmark`, `-flush` and `-replace`, plus
`/admin/ydoc-snapshot`, served over plain HTTP on the collab port. The Next side reaches them
through `src/lib/collab-http-origin.ts`, which resolves `COLLAB_INTERNAL_URL` or the loopback
port and **never `NEXT_PUBLIC_COLLAB_URL`** — a `NEXT_PUBLIC_` variable names how the browser
reaches something, and using it server-to-server sent every admin call through nginx to a
Hocuspocus that answered "Welcome to Hocuspocus!" with a 200 (docs/YDOC.md, "The
server→collab HTTP origin"). Every caller logs a non-`ok` response.

**Co-authoring and presence.** `AuthorHighlight` turns on inside a body once its ydoc has seen
two distinct user ids, and the collab server backfills the first author's mark over the
existing text in the same transaction that records the second (`attributeUpdate`). Presence
is one ambient line — "X is writing an annotation…" — wherever `AnnotationSection` sits,
sourced from `DocPresenceProvider` over the doc's own read-only awareness (awareness is not
gated by `readOnly`, verified in Hocuspocus's source), and published only while a composer is
open and not set to Keep private.

## Anchoring — three mechanisms, picked by surface

The rule is **the surface, never the permission**: an author reading `/doc/[slug]` gets the
same anchor kind as a reader, and `postAnnotation` takes an explicit `anchorMode` rather than
inferring one. A row has one form or none, never two.

| Written from | Anchor | Stored where | Can drift? |
|---|---|---|---|
| The doc editor | an `annotation` mark carrying the root's id, `excludes: ""` so several can overlap, rendered as `data-annotation-id` | the doc's ydoc; no columns | moves with its text; lost with it |
| A reading view (`/doc/[slug]`) | `anchorFrom`/`anchorTo`/`quotedText`, verified and derived server-side against the stamped state | columns, plus `ydocUpdateId` | yes — tracked and re-found at read time |
| The PDF viewer | `pdfTarget`: quads (primary), a quote with prefix/suffix (check), a position (hint), `textVersion` | one JSON column | no — the file's `sha256` is its identity |
| A reply, from anywhere | the column form, into the **parent annotation's body** | columns, plus the parent's stamp | as the reading view's |

**The mark is applied by the collab server**, asked by `postAnnotation` after the row exists
(row first, mark second: a mark that never lands leaves a document-level annotation, which is
a state the system already renders, where the reverse would leave a mark naming no row). The
editor captures the range as Yjs relative positions (`src/lib/yjs-relative-anchor.ts`) and
resolves them at *submit*, so the anchor reflects whatever a collaborator typed while the
composer sat open. Deleting the annotation, or moving it back to `DRAFT`, removes the mark.

**Why the reading views stopped writing marks**: a mark is an edit, and a
reader making one is a reader mutating a document they were denied write access to — through
a privileged path, unattributed in the update log, unbounded in volume, and keeping the mark
endpoint on the hot path for everyone. So a reading view writes three columns and touches the
document never. `captureAnnotationAnchor` materializes the stamped state, uses the client's
text only to verify and if need be re-find the offsets, and stores *its own* `textBetween` —
so replay to `ydocUpdateId` and `textBetween(anchorFrom, anchorTo)` is `quotedText` by
construction, forever, and nothing a client says is stored verbatim. `resolveAnchorInDoc`
(`src/lib/annotation-anchors.ts`) is that verify-then-re-find step, shared with the mark
endpoint's `handleApplyAnnotationMark` so the two mechanisms cannot disagree about what "this
quote is still here" means; its fallback search is `findQuoteOccurrences`, a plain scan that
cannot match a quote spanning a block boundary.

**Resolution at read time** is `AnnotationHighlight` (`annotation-highlight-extension.ts`),
three tiers per transaction: map the range through the transaction and verify against the
quote; search a window sized by the document's size delta; one full `findQuoteOccurrences`
scan, after which a miss stays detached until the next anchor push rather than costing a scan
per keystroke. `resolveAnnotationRanges` (`src/lib/annotation-marks.ts`) merges the mark scan
and the tracked ranges into one id → range map, and every consumer — both rails,
`AnnotationClick`, the quote header's jump — goes through it without knowing there are two
mechanisms. The doc editor runs the decoration too, so an author rewriting an annotated
passage can see it was annotated. **No reading view writes a repair back**: it is a tap at
least one update behind, and N readers correcting one field would be last-writer-wins on the
one value whose job is precision.

**Degradation differs on purpose.** A lost mark leaves nothing behind, so the annotation
becomes a document-level remark in the general discussion, derived per render from the marks
present in `proseJson` — no stored status, so nothing can get stuck detached. A detached
column anchor keeps its blockquote, because it was derived against a reconstructible state.

**PDF anchors** resolve quote-first (searching outward from the position hint), then quads,
then orphaned if the text under the quads fails the check; the quads always resolve, so the
viewer is correct without the fuzzy tier. `quotedText` is sliced server-side from
`file_page_text`, extracted once at upload by the same normaliser the browser uses. The only
thing that can invalidate a stored anchor is that normaliser, hence `NORMALISER_VERSION`
(docs/PDF.md §3, §4). A rectangle-only annotation stores an empty quote.

### Replies anchor into their parent

Selecting inside a posted body opens a reply anchored to that passage; the target is chosen
from `parentAnnotationId`, never taken as an argument, so a reply cannot quote the document
and a root cannot quote another annotation. A selection with a reply already open re-points
it rather than opening a second composer; an empty selection is ignored, since clicking into
the sibling composer collapses the body's selection. The pending decoration appears at once,
the `DRAFT` row waits about 300ms for the selection to settle (a timer rather than
`pointerup`, so shift+arrows settle the same way). Direct replies are drawn inside the parent
in each replier's colour, clickable to flash the reply's card.

### The version stamp

`ydocUpdateId` means **the earliest revision at which this annotation is locatable**, and
names the log of whichever document the anchor is measured against:

- A column anchor from a reading view: the version the author was *looking at*. The client
  captures a `Y.snapshot` in the same tick it reads the offsets (`src/lib/ydoc-version-client.ts`;
  a state vector alone cannot distinguish states that differ by a deletion — 9.5% of update
  rows carry no structs), and `src/lib/ydoc-version.ts` converts it to an update id, walking
  back from the rolling checkpoint `Ydoc.lastUpdateId` that the store debounce writes after
  draining the per-document append queue (`drainAppends`), so the checkpoint never names an id
  older than the content it stamps. About 2ms on the common path.
- A mark anchor: the update that *carries the mark*, which is after what the author saw,
  because the collab server applies the mark as its own update. `postAnnotation` re-stamps
  after a successful apply; stamping the earlier state scrubbed to a document where the
  annotation provably was not attached.
- An anchored reply: the mark of the parent's newest snapshot, i.e. its last settled version
  (`parentSettledMark`) — exactly what the replier read, since a reader of a body sees settled
  text and a client has no live connection to a parent body to snapshot from; the parent
  log's tail is the fallback for a body with no snapshot. Not `proseJsonUpdateId`, the cache's
  own checkpoint, which can trail a Done.
- An anchorless annotation: the doc log's tail. A PDF root: null, since a file has no log.

"At this revision" on a card seeks the doc's scrub bar to the stamp, and renders only once
the scrub bar has registered a seek. For an anchored reply it names a position in a
different log — an accepted cost, retired by PLAN.md §20e when anchor rows arrive.
`scripts/integrity/check-annotation-anchors.ts` pins the triple invariant and, for marks,
that the mark is present at the stamp.

### Composing from the doc editor

The editor's rail could show what had been said; composing there needed an anchor that
survives a collaborator editing *inside* the range while the composer sits open, which the
reading view's selection cannot. That is a Yjs relative position, and the editor is the one
surface that can convert one, because it has a `ySyncPlugin` binding
(`src/lib/yjs-relative-anchor.ts`: `captureRelativeRange` / `resolveRelativeRange`, never
serialized — `gc: true` rules a persisted one out). `use-editor-annotation-widget.ts` is the
editor's counterpart to `useSelectionPopover`, minus the text-search fallback: the captured
range either still resolves or the content is gone. It resolves at *submit*, so the final
anchor reflects whatever concurrent typing happened while the composer was open.

**Two stages, because selecting text while editing is not a request to annotate.** On a
reading view a selection is a strong signal; in an editor it is how you bold a word or read
with the mouse, and a panel over the text on every one of those is noise. So stage one is a
28px outline marker in the gutter, level with the start of the selection, costing no row, no
connection and no layout change; stage two is the composer, opened where the marker was, on
click, with `AnnotationPopover`'s `autoOpen` so the surface does not ask twice. The pending
decoration is applied at stage two only: with the editor focused the native selection already
shows the range, and a dashed underline on every selection made while editing is the noise
the marker exists to avoid — so on every surface `.pending-annotation` means "a composer is
open on this range".

**The width floor is derived, not chosen.** The text column is centred at `max-width: 800px`,
so its right edge sits at `(W + 800) / 2 − 16`, and the marker needs 44px clear to its right:
no gutter exists below **W ≥ 856**, and the floor is 900px, STYLE.md's nearest documented
width. Below it the marker is not offered at all rather than clamped back over the text; a
doc's annotations are still composed from its reading view, which has no floor.
`e2e/text-selection.spec.ts` asserts the clearance at 1280, 960 and 900 and its absence at
700, so the arithmetic cannot go stale if the column's width or padding changes. The
*expanded* panel is best-effort about staying clear of the text (above about 1200px it does;
below, it overlaps), and that ~1200 is the panel's own width against the column, unrelated to
the rail's 1180 — worth naming, because two unrelated ~1200s is how one gets "corrected" into
the other.

**A reentrancy bug, found by e2e.** `CollabEditorBody`'s `onUpdate`/`onSelectionUpdate`
originally fired synchronously from inside tiptap's `dispatchTransaction`, and the widget's
`reresolve`/`clear` can themselves update state and dispatch a further transaction on the
same view: typing at the very start of a document under `page.keyboard.type` landed the
string mid-word in about 35% of runs. Two fixes, both kept: `clear` is a true no-op when
nothing is pending (it runs on every keystroke's empty selection here), and both callbacks are
deferred with `setTimeout(fn, 0)` — not `queueMicrotask`, which can still run before the
browser finishes dispatching the next queued input event. Together they cut the rate to
roughly 1 in 10 to 14 runs, and the residual reproduces identically with both callbacks
registered as empty functions, so it is tiptap/prosemirror-view's own pipeline under
keystroke rates no human produces. Accepted rather than chased.

**And a silent one.** `yjs-relative-anchor.ts` imported `ySyncPluginKey` from `y-prosemirror`,
but Tiptap v3's `Collaboration` binds through `@tiptap/y-tiptap`, a separate package with its
own `PluginKey`; `getState()` matches by identity, so the wrong key resolved to `undefined`
without an error and the widget never appeared on any real selection. It imports from
`@tiptap/y-tiptap` now, an explicit direct dependency (docs/TIPTAP.md).

**Not built:** presence for a selection or a marker before a draft row exists.

## Lifecycle: DRAFT → LIVE → RAISED

A freshly opened composer **is** a `DRAFT` row with a ydoc, created eagerly
(`createDraftAnnotation`) so the editor has something to connect to before a keystroke lands,
and discarded if closed empty. The reading view's popover asks first, so a selection still
being dragged does not spin up a row per pixel. "Move to bottom" re-targets which composer
slot renders the id — same row, same ydoc — rather than copying content between two Yjs
lineages.

**Posting** (`postAnnotation`, `postFileAnnotation`) *settles* the body first
(`settleAnnotationBody`): asks `/admin/annotation-flush` for the drained tail of the body's
own log without a cache write, with a bounded retry (a keystroke immediately followed by a
click can outrace the websocket), materialises the body at that mark and validates it as
non-empty and at most 5,000 characters. Then it captures the anchor for the chosen mode and,
in one transaction, writes **version 1** — a `ydoc_snapshot` at that mark — the cache columns
from the same decoded document, `postedAt`, and the status. "Post" is `LIVE`; "Keep private" stays `DRAFT` (`saveDraftAnnotation`,
reachable again through `OwnDraftsList`); "Post & notify authors" is `RAISED` — one
`sendMail` per byline author, or per file owner, and `raisedAt` stamped. Any `DRAFT` can be
posted later, any `LIVE` raised later; a `RAISED` annotation re-notifies nobody on edit.

**Deleting** stamps the soft-delete columns and removes the mark; `deleteAnnotation` is
`requireOwnOrAdmin`. Nothing is notified. Restoring is the reverse without a re-mark.

**`/annotations` excludes `DRAFT` rows outright** rather than scoping them, because "keep
private" means private from an `ADMIN` too.

## Editing after posting

Built 2026-09-16, planned as PLAN.md §22e. An annotation body is already a collaborative
document with a never-truncated log and a materializer, so "every version is kept" means a
**boundary**, not a copy: a version is a `ydoc_snapshot` on the body's own ydoc — one at
DRAFT → LIVE, one per Done that changed anything — recording where a settled state began, who
settled it (`userId`) and when (`createdAt`). There is no text copy anywhere. The history
decodes each version from its snapshot bytes on demand (`decodeAnnotationSnapshot`,
`src/lib/annotation-body.ts`), and a snapshot is a full state, so that is a decode per version
rather than a replay per version. Why not a revision table with the text in it: "Decisions".

**`editingSince` is the whole trick.** While it is set, the store debounce skips its write,
so `proseJson` means "the last settled body" and every reader path — rails, lists,
`/annotations`, the history — kept reading it unchanged; nobody sees anybody else's
keystrokes, and the awareness-mounted live editors docs/COLLAB.md's 2026-08-13 entry weighed
were not needed. This is why CLAUDE.md's rule against positioning off `Doc.proseJson` does
*not* transfer to this column. The flush endpoint ignores the guard on purpose: a flush is an
explicit "write it now", and `saveDraftAnnotation` is what asks; a settle asks it only for the
mark (`writeCache: false`) and writes the cache itself.

**The session.** Edit on `AnnotationNode` (author or `ADMIN`) calls `beginAnnotationEdit`,
which stamps `editingSince`; the card mounts `AnnotationEditSession` — the composer minus
everything about posting, sharing the connect/destroy/token-refresh lifecycle through
`useAnnotationProvider`. Done calls `finishAnnotationEdit`, which settles the body
(`settleAnnotationBody`): the drained mark from the flush, the body materialised *at* that
mark, decoded with the same function the cache writer uses, and validated — an emptied or
over-long body is refused with nothing written, so readers keep the settled text and the
session stays open for the author to fix it. Then one transaction (`writeSettledBody`) creates
the snapshot at the mark, writes `proseJson`/`bodyText`/`proseJsonUpdateId` from that same
decoded document, stamps `editedAt` and clears the flag; the cache and the newest version agree
by construction, and `postedAt` and version 1's timestamp are one instant. A session that
changed nothing writes nothing, so opening and closing the editor cannot close the grace
window. Cancel calls `cancelAnnotationEdit`, which decodes the newest snapshot and asks the
collab process (`/admin/annotation-replace`) to write it back — Yjs has no un-apply, so a
cancel is new log rows that restore the old text, and the versions stay a strictly increasing
sequence of marks. A session left open is settled on the author's next visit, and *who* is
visiting decides how: the author gets **Resume editing** immediately, because
`beginAnnotationEdit` only ever makes a *stranger* wait — its freshness check is skipped when
`Annotation.userId` is the caller, so a reload mid-edit costs nothing, and the card says "You
have an edit open since …" rather than reporting the author to themselves. Anyone else — an
`ADMIN`, or the author's session seen by the author's own admin colleague — reads "Being edited
since …" and waits until `editingSince` is older than `STALE_EDIT_SESSION_MS` (an hour), at
which point the card offers Resume or Discard. Staleness is decided by the loader rather than in
render. There is no column recording *which user* holds a session, so the two questions the UI
can ask are the two the server asks: "is this viewer the annotation's author" and "has an hour
passed" — which is why an `ADMIN` who reloads mid-edit on someone else's annotation waits out
the hour like any other stranger, and why the author's own Discard arrives only by way of
Resume then Cancel.

**The grace window** is docs/COMMENTS.md's, from `src/lib/edit-grace.ts`, with `posted` =
`Annotation.postedAt` and "something quotes this version" = an anchored, undeleted reply whose
stamp falls in the span that version settled — `isVersionQuoted`: a stamp in `(m[i-1], m[i]]`
names version *i*, the first version owning everything up to its own mark — so a quoted
version stays visible inside the window. The "edited" marker (`EditHistory`, the island shared
with comments) is parenthesized at the end of the meta line, directly after "at this revision"
— `placement="meta"`, the same mode a comment uses, which drops the edit time from the marker
into its tooltip rather than letting two timestamps sit side by side reading as a pair. It cost
this line some length, which was the reason it kept its own line until 2026-09-19 and was
accepted then in exchange for mirroring the comment side. Two things follow from the placement,
both of them already true of `CommentNode`: the meta line is a `div` and not a `p`, since the
panel that opens inside it is full of blocks, and `.meta` is a plain block and not a flex row,
since the panel is a block inside the marker's inline wrapper and a flex item would size it
into the line instead of under it. The body is hidden while the panel is actually *listing*
versions (`onVersionsShown`) — the current version is its first entry, so leaving both up would
show the same text twice — and not merely while it is open, because a panel that is loading,
failed, or showing nothing the viewer may see stands in for nothing. Opening it calls
`getAnnotationHistory`, which lists the body's snapshots in mark order, applies the silence
rule server-side and decodes each visible version for `AnnotationVersionBody`. The thread
loaders fetch a whole page's snapshot marks and timestamps in **one** query keyed by the
derived ydoc id — there is no Prisma relation from `annotation` to `ydoc`, by design — never
one per annotation, and take the reply stamps from the rows already in hand. `editedAt` is
stamped on every edit, silent or not, and `/annotations` shows it.

**Replies under a moving parent.** A reply's stored triple is resolved against the settled
`proseJson` at render — the three tiers run once per load — with tier 3's sticky detachment
relaxed for bodies (`retryDetached`), since a full scan of 5,000 characters is nothing. A
reply whose quote no longer resolves shows a "quoting an earlier version" link:
`getQuotedParentVersion` materializes the parent body at the reply's own stamp — a snapshot
mark, so a snapshot load with zero deltas — which is docs/COLLAB.md §7's materialize half,
built for the one case where it is affordable.

**Only the settle paths write a snapshot on an annotation ydoc.** `/ydoc-debug`'s Snapshot
button (`/api/ydoc/[id]/snapshot`) and the collab endpoint behind it (`/admin/ydoc-snapshot`)
refuse the namespace with a 409, because a snapshot there would be listed as a version nobody
settled.

**Permissions** are docs/PERMISSIONS.md, "Editing what is already posted": rewording and
removing are the same act on the same person's work, so both are author-or-`ADMIN`.

**A settled body has to be pushed into the card's editor; a refreshed prop is not enough.**
`AnnotationBodyReader` is a read-only ProseMirror editor, and `useEditor`'s `content` is a
construction-time option — @tiptap/react's re-render path calls `setOptions`, which never
re-parses it (docs/TIPTAP.md, "`useEditor`'s `content` is construction-time only"). Clicking
Done sets `editing` false and calls `router.refresh()` in one batch, so the reader remounts
with the *pre-edit* prop and then ignores the new one when it arrives: the card showed the
text as it read before the edit until a full page load. Fixed 2026-09-19 with a value-compared
`setContent(next, { emitUpdate: false })` effect, the same delivery `use-live-doc-content.ts`
uses for a doc.

The shape worth recognising is **a prop-fed ProseMirror editor on data that has become
mutable**: the freeze is silent, and it arrived here not by changing this component but by
giving a posted body an editor (§22e) that §13p had built on the assumption it never changed.
The `staticBody` copy kept updating correctly the whole time — it was just behind
`display: none`, which is also why nothing looked broken in the DOM.

## Rendering, rails and delivery

`annotation-entries.ts` turns loaded threads into rendered entries on the server, quote-
anchored threads first and every general one after (a doc can have many, one per annotation
whose mark is gone). `AnnotationList` and `AnnotationNode` render them; `AnnotationNode`
renders itself for replies. `/doc/[slug]` fetches its threads once and hands the same list to
the body and to `AnnotationSection`, since two fetches would be two snapshots that could
disagree about which annotations exist. The margin rails are `src/components/margin-notes/` and
`src/lib/margin-notes-layout.ts`, and CLAUDE.md's invariant holds: only the cards move, CSS
owns the two-column grid, JS owns the vertical alignment, and which ids are anchored is seeded
from data (`quotedText !== ""`) and then overridden by the live scan. The PDF rail keeps
out-of-view cards as `display: none`, never unmounted, because a card can hold an open reply
composer — a live connection and a `DRAFT` row.

**Delivery after a write** is `annotationRevalidationPaths` plus a `router.refresh()`, and on
`/doc/[slug]` that is the whole story: the surface renders annotations from the server tree.
`/pdf/[slug]` cannot rely on it — its viewer sits behind `next/dynamic({ ssr: false })`, and a
refresh there is a transition that can silently fail to commit — so that surface fetches its
own list (`loadPdfAnnotationEntries`) through `AnnotationReloadContext`, whose default is a
no-op. Don't wire the context into the doc surface for symmetry.

**Colours** are `User.color`, one per person (`src/lib/author-colors.ts`), painted through
`AnnotationColorStyles` (rendered by `AnnotationSection`, so on the reading views only — the
editor's highlights keep the neutral fallback) and `authorHighlightBackground`; docs/DASHBOARD.md lists the four
places a colour is cached and how stale each can be.

## Verification

- **Integrity** (`scripts/integrity/README.md`): `check-annotation-anchors.ts` (the triple
  reproduces at the stamp; a mark is present at its stamp; a reply's stamp names its parent's
  log), `check-annotation-snapshots.ts` (`posted-snapshot`, `monotone`, `settled-cache`,
  `stale-session` — run after `check-ydoc-integrity.ts`, whose check 4 already holds every
  snapshot's bytes to a replay), `check-pdf-anchors.ts` (the quote is the server's own slice
  of the page text).
- **e2e**: `doc.spec.ts`'s five annotation tests (column anchor with no mark written, the
  degraded state, the stamp is what the author saw, anchored replies, the editor's rail),
  `annotation-editing.spec.ts`, `annotation-readonly.spec.ts` (from Node, with real cookies —
  the only way to test a rule no page exercises), `pdf-annotations.spec.ts`,
  `margin-rail-widths.spec.ts`, `text-selection.spec.ts` (the popovers and the editor's gutter
  marker, including the 900px floor).
- **Fixtures**: `createTestAnnotation()` seeds the body's ydoc, sets `postedAt` and writes
  version 1 as a snapshot of the seed — without the ydoc an edit session connects to a document
  Hocuspocus auto-creates empty, and the first Done would settle that emptiness (refused).
  `getAnnotationEditFacts()` decodes the versions; `backdateAnnotationPosting()` moves
  `postedAt` and version 1's timestamp together, and `setAnnotationEditingSince()` the session,
  producing the intervals the grace and staleness rules compare, since neither reads a clock.
  `annotation-editing.spec.ts` also covers Done on an emptied body (refused, readers untouched)
  and a quoting reply closing the window. The cleanup worker deletes each test annotation's own
  `ydoc` row by name, which cascades its snapshots, since the row cascade cannot reach it.
- **Scripts**: `scripts/test-annotation.ts` and `test-annotated-doc.ts` (docs/TEST_DATA.md);
  `backfill-mark-annotation-stamps.ts`, the one-shot that fixed mark stamps written before the
  re-stamp existed; `backfill-annotation-snapshots.ts`, the one-shot that gave every body
  posted before versions existed its version 1.

## Decisions, and the alternatives rejected

The reasoning behind what the sections above describe, where the plan weighed something
else. One entry per decision; the measurements are the plan's own.

- **The formatting bar is hidden by default, and a bubble menu was set aside.** Zero idle
  chrome, but a bubble menu inside a popover that is itself absolutely positioned over the
  document is a z-index and flip-placement fight for a marginal gain over a toggle. Worth
  revisiting once the popover is stable.
- **A draft moves between composers by re-targeting, never by copying.** Merging two Y.Doc
  lineages is not a sound operation, and copying JSON discards the draft's history and
  attribution. A bottom slot already holding a different draft commits it first — posted
  `LIVE`, document-level, no notify — unconditionally quiet, because posting as a side effect
  of moving something else must never notify anyone.
- **Author highlighting is backfilled, not left uncoloured.** Text typed before the second
  author arrived would otherwise carry no mark once highlighting turned on, which reads as a
  bug rather than a boundary. The backfill runs server-side in `attributeUpdate`, exactly
  once, in the transaction that records the second author, so it depends on no client staying
  connected.
- **Two awareness channels, not one.** Discovery rides the doc's own provider, which every
  reader already holds (`annotationEditing: { annotationId, user }`, deliberately not named
  `cursor`); carets ride each annotation's own provider, one `CollaborationCaret` per editor,
  so the shared-provider awareness-key clash never arises. Whether awareness flows over a
  `readOnly` doc connection was verified in Hocuspocus's source rather than assumed. A
  `DRAFT` never publishes presence, or a private note would announce itself to every reader.
- **Draft rows are eager, with discard on close-while-empty.** Staying local until the first
  keystroke would produce no garbage but adds a promotion step to the editor's lifecycle. The
  two-stage popover is what keeps eagerness from creating a row per selection adjustment.
- **The mark is applied row-first, and the client never mints the id.** Mark-first would
  leave a mark naming no row; row-first leaves a document-level annotation if the mark never
  lands, a state already rendered. Because the server chooses the id, a client cannot mark
  text with another's annotation id. `excludes: ""` lets marks with different ids coexist over
  one span; ProseMirror splits the runs itself.
- **`/annotations` is scoped by readability, not manageability.** Its Quote column reads out
  of the doc's body, so a scope any wider would show an excerpt of a `PRIVATE` doc to someone
  `/doc/[slug]` refuses outright. Deep-link filters apply after that scope, never instead of
  it, and `DRAFT` is excluded outright because private means private from an `ADMIN`.
- **The mark stamp names the update that carries the mark, measured.** At update 64951, an
  annotation's own stamp, the document carried four annotation marks and not that one's; its
  own first appears at 65049. Stamping the earlier state scrubbed "at this revision" to a
  document where the annotation provably was not attached, and the card dropped out of the
  rail on click. `backfill-mark-annotation-stamps.ts` fixed the older rows; `mark-at-stamp`
  in `check-annotation-anchors.ts` guards it.
- **A snapshot, not a state vector, and this cost a wrong implementation.** A state vector
  summarises insertions only, so two states differing by a deletion encode identically; on a
  real corpus 9.5% of `ydoc_update` rows carry no structs, in runs of up to 22, so a vector
  alone is ambiguous across a whole run. `Y.snapshot` pairs the vector with the delete set —
  verified 4/4 exact inside a real deletion run. `Y.encodeStateVectorFromUpdate` is the wrong
  primitive and fails silently: it answers for a document built from that update alone, so it
  returns empty for every row after the first (1,350 of 1,353 on the document tested), and
  the walk then resolved completely different states to one id, which read as corrupt data
  and was not. `decodeUpdate().structs` is what it gets mistaken for.
- **Broadcasting the id was rejected.** The collab server could `broadcastStateless` the
  current id after every append and let clients stamp what they last heard: one extra
  message per Yjs update, permanently, on the busiest path there is, to serve an event that
  happens a few times a day. The snapshot puts all of its cost at post time.
- **The checkpoint retired opportunistic snapshotting.** Before `Ydoc.lastUpdateId` the walk
  began at the newest `ydoc_snapshot` the client covered, and snapshots are created
  deliberately, never implicitly — so a doc that has never been published had none and the
  walk covered its whole lifetime: 1,219 rows on a real document, 15ms, against 2ms on the
  head fast path once the checkpoint existed. The alternative was to snapshot opportunistically
  and reverse the invariant that a snapshot is a deliberate act. The two writes sit on
  different paths: `appendUpdate` records its id as a side effect nothing awaits, and the
  debounce drains the queue (`drainAppends`) before writing the checkpoint, or it would stamp
  content with an id older than itself.
- **Capture is in the same synchronous tick as reading the offsets.** From the moment a
  selection exists the surface is frozen while `useLiveDocContent` keeps applying updates to
  the Y.Doc, so a version captured any later names something the reader was never shown.
  `reresolve` re-versions as well as re-positions.
- **Older rows keep a null stamp** rather than a backfilled guess: the honest value is
  "unknown", and a guess is indistinguishable from a real stamp while sending the walk
  somewhere wrong.
- **A version is a snapshot, not a row in a revision table.** A table holding a text copy per
  settled state was the obvious shape, and it was rejected because the copy is redundant and
  the boundary is not. A body is 100–5,000 characters, `getQuotedParentVersion` already
  materialises one at an arbitrary mark in a few milliseconds, and the update log is never
  truncated — so the text is reconstructible, while *where an edit session ended* is the one
  thing the log cannot say: annotation readers see a step function of settled states, never
  keystrokes, so for a body the log is not what anyone saw, and every feature phrased in
  versions (the marker, the history, a window that hides a whole session, Cancel) needs the
  step positions. `ydoc_snapshot` already records exactly that kind of boundary for a doc (a
  publication), `loadReplaySlice` already uses one as its replay base, and
  `check-ydoc-integrity.ts` already verifies every snapshot's bytes against a replay — so a
  table would have been a second, unverified copy of a record that existed. Two consequences
  settled it. Writing the cache **from** the snapshot, in its transaction, means a Done cannot
  dirty the cache with a body that then fails validation, which a flush-then-validate design
  does. And a reply's stamp is the parent's newest snapshot mark rather than the cache
  checkpoint `proseJsonUpdateId`, which can trail a Done (the flush writes content without an
  id; the debounce skips a body under edit) and so name a state the reply's quote does not
  reproduce. The reader-facing model stays settled versions, not a key-by-key scrub: the log
  starts at draft creation and Cancel writes restore rows, so a scrub would show the drafting
  before Post, every mid-session keystroke and every abandoned attempt — the deal doc authors
  accept and the one annotators were explicitly not given — and it would half-hide a session
  straddling the three-minute mark. If that premise ever changes, the replay machinery is
  generic already and these snapshots are its rebuild points; it would mean dropping the
  annotation grace window, not amending it.

## Deviations from the plan

From the original design (PLAN.md §12i and §13, now stubs):

- **Reading views stopped writing marks** (§13o) — §12i's "a reader can annotate without a
  writable connection" turned out to describe a reader mutating a document they were denied.
- **`DRAFT` and its three actions shipped with the editor, not with the lifecycle phase**: a
  live editor for unposted content needs a row to attach to.
- **The inline popover is two-stage**, so a selection still being dragged creates nothing.
- **`OwnDraftsList` exists** because "Keep private" needed a way back in.
- **The flush endpoint exists** because a just-posted annotation could render empty from a
  cache the debounce had not yet written.
- **Presence is one ambient line**, not a marker on the anchored text: a not-yet-posted
  annotation has no stable anchor to hang one on.
- **The old textarea composer and `submitAnnotation` were deleted**, not deprecated.
- **The writable connection every reader had** — recorded as a gap with no UI on it —
  closed the other way: since 2026-09-16 only the author or an `ADMIN` gets one.

From §13q: **replies stamp the parent's cache checkpoint** rather than the tail, once editing
made bodies mutable.

From §18 (the rails, docs/MARGIN_NOTES.md): **the editor's cards are interactive**, not
read-only; **phone landscape is a queue**; the anchorless pre-filter moved from the page into
the rail; the composing surface's
**width floor is 900px**, measured, not the 428px it was specced against; the pending
decoration is applied at stage two only; and `yjs-relative-anchor.ts` imports its plugin key
from `@tiptap/y-tiptap`, not `y-prosemirror`, because the wrong package's key resolves to
`undefined` without an error.

From §19: the annotation panel is a **tabbed side panel** with an icon toggle, not a button;
it speaks the file's vocabulary; **`RAISED` is unreachable from the PDF UI** though the mail
path is live; `PdfAnnotationList` is `PdfAnnotationPanel` with `use-pdf-margin-notes.ts`.

From §22e: **the reply stamp is the parent's newest settled version, not a client snapshot**
(a client reading a body has no `Y.Doc`); **staleness is a loader field**, since reading the
clock in render is impure and differs across hydration; `/admin/annotation-replace`,
`useAnnotationProvider` and the shared decoder `src/lib/annotation-body.ts` were not named by
the plan; the flush endpoint's `writeCache` flag was chosen over restoring the cache from the
newest snapshot when validation fails, because it makes the invalid write impossible rather
than repaired.

From §20: **`annotation_anchor` rows (PR 2) are not built**; an annotation's own anchor stays
in its columns or `pdfTarget`, and the stamp keeps its overload ("The version stamp").

## Not built, deferred

- **Resolve / unresolve.** `resolvedAt` is schema-only; nothing writes or reads it.
- **Anchor rows for annotations** (PLAN.md §20e), which would also un-overload the stamp.
- **The repair half of docs/COLLAB.md §7.** The stamp makes materialize-and-diff buildable;
  nothing consumes it as a resolution input. The doc editor's rail is the honest place to
  persist a correction, and does not yet.
- **Anchors on the scrub view** resolve against the live document, not the scrubbed state.
- **A cross-paragraph column anchor loses its highlight on the first live sync** (TODO.md):
  a paragraph break costs two positions but renders as one space, so no text search can
  reproduce the range, and only the exact offsets ever resolve it.
- **The in-progress selection's anchor is weak** (docs/COLLAB.md §4, §5): offsets plus a
  re-resolve on the reading view; relative positions wait on decoupling the scrub preview.
- **Presence for a selection or a gutter marker** before a draft row exists.
- **Live co-editing of a posted body.** Readers see the settled text until Done; the
  awareness-mounted editor design stays available.
- **A file annotation reply's quote is client-supplied** (TODO.md); the doc side derives it.
- **No diff between versions**; the history lists them whole.
- **PDF fuzzy matching and lazy re-anchoring after a `textVersion` bump** (docs/PDF.md §3,
  §4); the quads carry every annotation meanwhile.
- **`/annotations`**: the "Quoted text position" sort ties for mark-anchored rows; the
  deep-link filters have no UI; the Quote column cannot say what a reply's quote is a quote of.
- **The rails' own gaps** are docs/MARGIN_NOTES.md, "Known gaps".
- **The append-queue drain has no test**, and rows from before the stamp existed stay null.

## History

- **2026-07-28** — §12i: an annotation is a mark in the doc's ydoc, applied by the collab
  server; comments and annotations share one `Comment*` component set.
- **2026-07-29** — §13: the body becomes its own ydoc with a live editor; `DRAFT`/`LIVE`/
  `RAISED`; the components un-share.
- **2026-08-11** — §13m: the production-only admin-endpoint bug, and `collab-http-origin.ts`.
- **2026-08-12** — §18: the margin rails; §13n: the version stamp.
- **2026-08-13** — §13o: reading views anchor by columns and stop writing marks; §13p: replies
  anchor into their parent; §13q: the stamp is what the author saw.
- **2026-08-24** — §19: annotations on PDFs.
- **2026-08-30** — §18f: composing from the doc editor, with relative-position anchors.
- **2026-09-16** — §22e: editing a posted body, with versions as snapshots on the body's own
  ydoc; read-only tokens for everyone but the author.
- **2026-09-17** — the rail grows with the window.

Migrations, in order: the 2026-08-01 baseline carries §12's and §13's columns;
`add_annotation_ydoc_update_id` (2026-08-12); `add_annotation_anchor_columns` and
`add_ydoc_version_stamps` (2026-08-13); `add_pdf_annotations` (2026-08-24);
`add_annotation_edit_sessions` (2026-09-16), followed by the one-shot
`scripts/backfill-annotation-snapshots.ts` for version 1 of every body posted before it.
