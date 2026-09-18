# Comments — identity, moderation, rich bodies, editing, and quotation

**Status: built.** Threads, moderation and the admin table date from the first build
(PLAN.md §5, §6, §10); editing with history, rich bodies, the Markdown box and quotation
were built 2026-09-16 on `annotations-and-comments` (PLAN.md §22, §23). This file is the
as-built account, per the house convention: the plans stay in PLAN.md with their reasoning
about alternatives, and this file says what the code does and why, so that a reader can
work on comments without reading 1,300 lines of plan first. "Deviations from the plan"
below is where the two disagree. The annotation side of editing shares two modules with
comments and is otherwise a different mechanism; it is docs/ANNOTATIONS.md, "Editing after
posting".

## What a comment is

A `comment` is one row on a `comment_thread`, and a thread belongs to a post. A thread is
either the post's general discussion or a **passage thread**, anchored to a range of the
post's text by absolute offsets into an immutable `post_publication_event` plus the quoted
text — the mechanism docs/COLLAB.md §1 describes, carried forward on every publish by
diffing and mapping, and marked `DETACHED` when the passage no longer survives. Comments
reply to each other within a thread (`parentId`); a reply inherits its parent's thread and
never re-anchors.

The row carries:

- **`body`**, ProseMirror JSON over the comment schema below — the current text, and a
  cache of the newest `comment_revision` (see "Editing after posting").
- **`bodyText`**, the body's plain text, derived by `commentBodyText` and written beside
  `body` by every writer, never by a trigger. `/comments`' free-text filter searches it,
  excerpts read it, and `checkSpam` sees it.
- **`status`** — `PENDING`, `APPROVED` or `SPAM` — plus soft-delete columns, `ipAddress`
  for the rate limit, `statusChangedById`, and `editedAt`.
- A **`commenter`** — Disqus-style identity: a name and an email, and a `userId` when the
  commenter was signed in. The row also carries `approvedCount` and `forceModerate` for the
  trust model.

A comment's permalink fragment is `commentAnchorName(displayName, createdAt)`
(`src/lib/comment-anchor-name.ts`), extracted so that the card and the quotation citation
cannot drift.

**Surfaces.** The post page renders every approved comment server-side into its static
HTML: `CommentSection` below the article, with the form, the sort control and the tree, and
above 1180px the cards whose thread still anchors move into the margin rail
(docs/MARGIN_NOTES.md).
`/comments` is the site-wide admin table and `/post/[id]/comments` the per-post queue.

## Identity, moderation and abuse

**Identity.** A signed-out commenter must give a name and an email; a signed-in one is
the `commenter` row keyed to their `userId`. Email is what ties anonymous comments to a
stable identity for the trust model. There is no verification.

**The identity fields wait for `useSession`.** The post page is statically generated, so
its HTML has no session and the first render is the signed-out one. The name and email
inputs are `required`, and a submit made before the session answers fails constraint
validation instead of posting — no request, no error, no console line. `CommentForm`
renders the pair only once `status !== "loading"` and disables the button until then. It
surfaced only under a loaded e2e run, because locally the session answers long before
anyone has typed a sentence.

**Moderation.** Each comment's required policy resolves as post override → author override
→ site default, each level `always`, `auto` or `inherit`. Independently, a commenter with
`approvedCount >= trustThreshold` (site setting, default 3) auto-approves, and
`forceModerate` on the commenter always queues. Resolution for a new comment: an `ADMIN`
publishes and skips the spam check; else `forceModerate` queues; else a trusted commenter
publishes; else the cascade decides. The threshold changes an outcome only where the
cascade resolves to `always` ("Decisions" below). `/site-settings` edits the default
policy and the threshold.

**Spam.** `checkSpam` (`src/lib/spam-check.ts`) is a stub: it logs and returns `false`,
whether or not `AKISMET_API_KEY` is set. It runs on every submit and every edit by a
non-admin, so wiring a client is a one-file change.

**Rate limits** (`src/lib/rate-limit.ts`): five posts per IP and five per commenter in a
rolling ten minutes, counted from `comment` rows; five edits per *user* in the same window,
counted from `comment_revision` rows, because the post limiter is blind to edits. The e2e
suite shares one IP with any hand-posted dev comments — "Verification" below.

**Who may do what** is docs/PERMISSIONS.md's "Editing what is already posted" and "Quoting
into a comment", and the moderation rows elsewhere in that file. In short: moderating and
editing another's comment are one gate, `canUserEditPost` on the thread's post; an
anonymous commenter can never edit, since nothing can prove they are the same person.

## `/comments`

The site-wide table: every comment across every post the viewer can manage — all of them
for `ADMIN`/`EDITOR`, own posts for `AUTHOR`, the same gate as `/posts`. It is one of the
admin-table kit's instances (CLAUDE.md's first invariant): filtering, sorting and pagination
happen in Postgres, and `comments-query.ts` is the one place that knows the querystring
(`status`, `threadStatus`, `deleted`, `q`, `page`, `pageSize`, `sort`), so a control change is
a `router.replace()` rather than a client-side re-filter of a downloaded array. `q` searches
`bodyText` and the commenter's name and email, debounced; `post`, `author` and `commenter` are
deep-link-only filters, documented in the on-page Help table. Row actions are Approve / Pend /
Spam (`moderateComment`) and delete / restore; bulk actions act on the current page's
selection (`bulkModerateComments`, `bulkDeleteComments`, `bulkRestoreComments`), each skipping
rows it does not apply to rather than erroring on a mixed selection. The commenter-activity
column (submitted / in moderation / spam) comes from a separate light query scoped to role and
deep-link filters only, so it summarises the commenter rather than the filtered page, and is
display-only because sorting it would need a correlated subquery. The Edited column has been
non-empty since editing arrived. `/post/[id]/comments` is the per-post `PENDING` queue.

## The body — one schema, two front doors

**The schema is the validation.** `commentContentExtensions` in `src/lib/tiptap-schema.ts`
is `Document, Paragraph, Text, Bold, Italic, Strike, Code, Blockquote, BulletList,
OrderedList, ListItem, HardBreak, Link, Quote`, with `blockquote` carrying an `anchorId`
attribute; `pmCommentContentSchema` is `getSchema` over it. A node or mark the schema does
not define makes `nodeFromJSON` throw, so there is never any HTML between commenter and
reader and no sanitizer to keep in step. The list is stated on its own rather than derived
from the doc or annotation lists, so that what a stranger may put in a comment can diverge
from what an author may put in a doc without anybody noticing at the wrong moment.

Out, and why: **images** (a stranger's `src` is a request every reader's browser makes to a
host the stranger chose — the same objection PLAN.md §17n records for "avatar from URL");
**headings** (a comment is not a document with sections, and a stranger's `<h1>` competes
with the article's outline); **tables, code blocks, rules** (no demand, each additive
later); **raw HTML in any form** (no extension, so the schema cannot express it).

**`parseCommentBody`** (`src/lib/comment-body.ts`) is the one gate every writer goes
through: nesting depth against `MAX_COMMENT_DEPTH` (6 — `> > > > > >` and indented lists
nest without limit from a textarea), then `nodeFromJSON` over the output of
`hardenCommentLinks` (every link gets `rel="nofollow noopener"` and `target="_blank"`, and
an href that is not `http`, `https` or `mailto` is dropped) plus `node.check()`, then the
text against `MAX_COMMENT_CHARS` (5,000). Before it, `resolveCommentBody`
(`comment-body-resolve.ts`) is where the two doors converge and where the wire is bounded:
rich JSON against `MAX_COMMENT_JSON_CHARS` (60,000), Markdown source against
`MAX_COMMENT_MARKDOWN_CHARS` (8,000) before parsing. Links are hardened a second time by
`Link.configure`'s HTML attributes on the renderer; neither depends on the other. Never
store a parse result — from Markdown or from the rich editor — without `parseCommentBody`
after it.

**The null-prototype trap.** ProseMirror builds every non-empty `attrs` with
`Object.create(null)`, and React's server-action encoder replaces such an object with an
inert placeholder that throws when Prisma serializes it. Every anchored quotation has attrs,
so every comment carrying one hits it. `toPlainJSON` (`tiptap-schema.ts`) before the action
boundary, `nodeFromJSON` on the far side.

**Rendering** is `renderToReactElement` in `CommentBody`, under the `.prose` class, with
`nodeMapping`/`markMapping` for the citation line and the inline quote link. In a client
component the result must be `useMemo`ed on the content: the static renderer makes a new
element *type* on every call, so an un-memoed body remounts on every state change of its
parent and drags any live selection to the container's start (docs/TIPTAP.md,
"`renderToReactElement` builds a new tree type on every call").

### The Markdown box

`CommentBodyInput` is the two-door control. **Markdown is the default**: it is the textarea
the form always had, so every older spec and the no-JavaScript submit keep working, and the
rich editor is a "Rich text" button away. The choice is remembered per browser in
`localStorage` (`rememberedCommentBodyMode`).

The parse runs on the **server**, in `markdownToCommentContent` (`src/lib/markdown-import.ts`),
headless — which is what turns raw HTML into literal text. A browser-side parse would make
real nodes of it, so there is no client-side preview and no client-side conversion:
switching modes with content in the box is a round trip through `convertCommentBody`, and an
empty box switches instantly. Markdown source is capped at `MAX_COMMENT_MARKDOWN_CHARS`
(8,000) before parsing.

The parse list is a **superset** of the schema: `commentContentExtensions` plus three
parse-only shims, because `@tiptap/markdown`'s fallback emits a `heading` node and deletes
fences and tables whatever is registered. A heading becomes a bold paragraph, a fence a
paragraph of `code`-marked lines joined by hard breaks, a table its raw source one row per
line. A soft line break becomes a space. docs/DOC_IMPORT.md §11 has the measurement and the
shim table; `src/lib/markdown-comment.test.ts` is the case-by-case proof.

**Editing serializes the stored JSON back to Markdown** (`commentContentToMarkdown`, via
`getCommentMarkdown`); there is deliberately no second stored form. A body parsed from
Markdown and serialized again re-parses to itself, and the last case in the test file says
so. An anchored blockquote renders as `> ` lines and an inline `Quote` mark as straight
double quotes, which is exactly what the matcher below looks for on save.

### The rich editor

`CommentEditor` is a TipTap editor over `commentContentExtensions` with `EditorToolbar`'s
reduced-set pattern, no collaboration extensions and no provider. Its value crosses to the
action as JSON through `toPlainJSON`. One trap it owns: `disabled={pending}` reaches TipTap
as `setEditable(false)`, which emits an `update` with the document unchanged — docs/TIPTAP.md
"`setEditable` emits an `update`". The draft store below is what has to absorb that.

## Drafts live in the browser

An unsent comment is a record in IndexedDB (`src/lib/comment-draft-store.ts`, one database,
one store), keyed by the composer it belongs to — the general form, a passage thread's form,
or a reply form. The inline edit box keeps no draft: an abandoned edit leaves the posted text
as it was.

**Why not a row.** A comment has one writer, so a CRDT buys nothing; most commenters have no
account to hang a row on; everything in `comment` has a status and appears in `/comments`,
and a draft must not be moderated, counted or rate-limited; and unlike a DRAFT annotation, a
comment draft is never shareable. What that costs — per-browser, per-origin, lost with site
data, invisible to the server — is correct for an unsent comment.

**Rules** (`useCommentDraft`):

- Every read and write is in `try`/`catch`; a failure means no drafts, never a broken form.
- Save is debounced on change. Restore on mount is silent plus a visible "Draft restored ·
  discard" line, because a silently restored paragraph the author had forgotten is how a
  stale one gets posted.
- **The restore gate is state, not a ref.** Nothing saves before the mount-time read has
  answered, or the composer would overwrite a draft it has not seen; but the gate opening has
  to be something the save effect can watch, or a body that arrived while the read was in
  flight (a paste, a restored quote, the first burst of typing on a slow page) is never
  saved.
- **`clear()` cancels rather than deletes.** Posting is the one moment a save is in flight
  for a body that no longer exists, because the submit itself changes the value one last
  time (`setEditable`, above). Deleting the row is not enough: the scheduled write lands
  after the delete and greets the author with "Draft restored" for a comment already on the
  page. So `clear()` cancels the timer and latches the composer closed, and only an empty
  body lifts the latch — which is what keeps `discard()` saving normally afterwards.
- Entries older than `DRAFT_MAX_AGE_MS` (30 days) are pruned on open. Not `y-indexeddb`:
  `src/lib/ydoc-persistence.ts` exists to work around that library's bugs with Yjs
  documents, none of which apply to a JSON value.

**Pending quotations ride in the draft**, in both modes: the rich body's placeholder ids
and their hinted targets, and the Markdown box's *unbound* hints from the off-page picker
(see "Quoting something not on the page"). That is what makes "select, wander off, come back
tomorrow, post" work.

## Editing after posting

**Every version is kept; the three-minute window is a display rule.** A `comment_revision`
row exists for every version including the first, written in the same transaction as the
comment (`submitComment`) or the edit (`editComment`), with a dense 1-based `revisionNo` and
an `authorUserId` naming who wrote *that* version — the commenter's user, or the moderator
who edited it, null for an anonymous original. `Comment.body` is the cache of the newest
row and is never written alone; there is no legitimate staleness window, and
`scripts/integrity/check-comment-revisions.ts` treats any divergence as a fault. Every reader
path still reads the column, which is why adding history changed no query.

**`editComment`**: the gate is own-comment or `canUserEditPost` on the thread's post — the
moderation gate, deliberately not a new predicate. Same validation as posting, the edit rate
limit, `checkSpam` unless the editor is an `ADMIN`; a no-op edit (identical body) writes
nothing, so a Save with nothing changed cannot close the grace window. A spam hit sets
`status = SPAM` with the editor as `statusChangedById` and still records the revision;
otherwise **status is unchanged** — an approved comment stays approved. Then, in one
transaction: revision `n+1`, `body`, `bodyText`, `editedAt`, and the quotation rows replaced
wholesale (below). `revalidatePostPage` afterwards.

**The grace window** is `src/lib/edit-grace.ts`, shared with annotations, and the only place
the rule exists. `EDIT_GRACE_MS` is three minutes from *posting* (`Comment.createdAt`), not
from the last edit, or a chain of small edits would stay silent forever. A superseded
revision is silent iff it was superseded within the window *and nothing quotes it*: a reply
that quotes "the sky is green" is a reply to those words, so a quotation taken during the
window makes the version it pins visible — the reader sees "edited", opens the history, and
finds the version the reply answered. `isSilentVersion`, `visibleVersions`,
`isVisiblyEdited` and `withSupersededAt` are the four predicates; a `supersededAt` is the
next revision's `createdAt`, never a column.

**Both loaders resolve the rule on the server.** `comment-data.ts` includes each row's
revision *timestamps* and its `quotedBy` count, never the bodies, and ships `editedAt` only
when the edit is visible — the existence of a silent edit is the thing being withheld, so
it never reaches the browser. Asking per comment would be an N+1 on a page of comments.
`editedAt` itself is stamped on every edit, silent or not, and `/comments` shows it: that
table is for people who moderate, and they get the truth.

**The UI.** `CommentNode` offers Edit beside Reply and Delete, to the comment's own author
and to `ADMIN`/`EDITOR` — the page is static and cannot know whether this viewer moderates
this post, so an `AUTHOR` moderating their own post edits from `/comments` instead. Editing
swaps the body for `CommentBodyInput` pre-filled in the remembered mode. The "edited" marker
is `EditHistory`, one client island shared with annotations: for a comment it sits in
parentheses at the end of the meta line, the word is the button and the time is its `title`.
Opening it calls `getCommentHistory`, which applies the silence rule server-side and lists
the visible versions newest-first, each rendered by `CommentBody` through the island's
`renderBody` prop; the island fetches on open rather than shipping revisions in the page,
because the post page is statically generated and must not touch a dynamic API at build.
Because a comment's panel opens above the body, `CommentNode` hides the live body while
versions are listing — the current version is the list's first entry.

**Delete and restore are untouched** by any of this; revisions cascade with the row.

**The annotation side** keeps its body in a ydoc, so "every version" there means a
boundary rather than a copy of the text — a `ydoc_snapshot` on the body's own ydoc per
settled state — plus an `editingSince` guard on the store-debounce cache. Same grace rule, same island, different
substrate: docs/ANNOTATIONS.md, "Editing after posting", and docs/COLLAB.md's 2026-09-16
entry for what it meant for anchoring.

## Quotation

A comment may quote a passage of the post, of any comment on the page, of another published
post or a public comment elsewhere, and — once a public file tier exists — of a PDF. A
quotation sits inline or as a block in the commenter's own prose, and is a row on
`comment_quote_anchor`.

### The anchor row

`comment_quote_anchor` is the third consumer of PLAN.md §20a's anchor envelope, and the one
that added the fifth arc leg: `doc_id`, `post_id`, `file_id`, `target_annotation_id`,
`target_comment_id`, exactly one non-null. Below the arc: `selector_kind`/`selector`,
`anchor_from`/`anchor_to`/`quoted_text`, `part_order`, and one of three version stamps —
`ydoc_update_id` for a body in a ydoc, `anchored_event_id` for a post's publication event,
`quoted_revision_id` for a comment revision. Three hand-written CHECKs (one target, selector
columns all-or-nothing, at most one stamp) in migration `comment_quote_anchors`, which also
put `target_comment_id` on `tag_anchor` and `anchored_link_anchor`, unused, because the
three tables share a shape by compiler and `check-tag-constraints.ts` probes that the
rewritten one-target CHECK counts the fifth column. `AnchorTarget` gained a `comment`
member; `canUserReadComment` (`src/lib/comment-authz.ts`) is the read predicate that arm
wears everywhere, and `canUserTagTarget` wears it too though nothing tags a comment yet.

**Why outside the body.** A mark lives in one document; a quotation joins a comment to a
*different* object. The body carries an `anchorId` and nothing else, which is also what lets
a quotation survive its target's deletion. And **why not `anchored_link_anchor`**: nearly the
same envelope, completely different lives — a link is a navigational object with an id, a
landing page and a tray, a quotation never exists on its own.

**Five substrates.** The envelope unifies the arc, not the selector:

| Target | Anchored against | Stamp | Resolution |
|---|---|---|---|
| A comment | an immutable `comment_revision` | `quoted_revision_id` | exact, forever |
| A post | an immutable `post_publication_event` | `anchored_event_id` | exact against the event; best-effort in the live article |
| A PDF | bytes, by `sha256` | none | exact, cannot drift (docs/PDF.md §4) |
| A doc body | a living ydoc | `ydoc_update_id` | verify, then search |
| An annotation body | its own living ydoc | `ydoc_update_id` | same |

Three of the five are immutable, so the interesting question is never "where did the
passage go" but "does it *also* still appear in the current version" — a display question,
answered by the citation line. `DOC_RANGE` is the selector kind for a post as for a doc: the
kind names the mechanism (offsets into a ProseMirror document with context), the arc and the
stamp name the substrate, and a `POST_RANGE` differing in no field would carry no
information. That is a recorded deviation from PLAN.md §20b's reservation.

### The audience rule

> **You may quote into a comment only what everyone who can see that comment may already
> read.**

Not "what the quoter may read": a signed-in `AUTHOR` can read a `SHARED` doc, the readers
of a public post's comments cannot, and a quotation copies the words into a body that
renders to all of them. `canQuoteTargetInto(target, host)` (`src/lib/comment-quote-authz.ts`)
asks it of the resolved target, at post time on the server and again at render, since a
target can stop being public after it was quoted — the words stay, the citation degrades to
"a source that is no longer available". The admitted set on a public post is: the host post
and any published post; an `APPROVED`, undeleted comment on a published post. Refused: a
`PENDING`, `SPAM` or deleted comment; any file, until PLAN.md §19 grows a public tier; any
doc, since there is no public doc tier; any annotation body, which inherits the above. So
the doc and annotation arms have no writer, and anonymous commenters may quote —
docs/PERMISSIONS.md "Quoting into a comment".

### Inline, block, and the words themselves

Two schema members, each carrying only an `anchorId`: `blockquote.attrs.anchorId` (null is
what the toolbar's quote button produces, so plain and anchored quotes are one node with one
renderer, plus a `<footer>` citation when anchored) and the `Quote` mark (self-excluding,
rendered as `<q>` wrapped in the citation link, the citation as its `title`). Only
*outermost* blockquotes are candidates; an anchored blockquote's descendants are never
anchored.

**The quoted words are real content in the body**, not a placeholder resolved at render:
the body renders with no joins and no per-quote permission filter, the comment survives its
target's deletion with its meaning intact, and what the reader sees is what the commenter
put there. **And the server rewrites them at post time**: `quoted_text` is derived from the
target at the pinned version by `quotedTextAt`, and the body's span is replaced with that
derivation before anything is stored — one paragraph per source textblock for a block, the
derived text under the mark for an inline quote (`applyQuoteResolutions`). The typed words
are only ever a query. That rewrite is what makes the fuzzy tier safe: a typo is corrected,
never stored.

**A quotation that cannot be derived degrades rather than refusing the comment**: the
blockquote keeps its text with a null `anchorId`, the inline text keeps its quote marks.

**Caps**, server-side: `MAX_QUOTES_PER_COMMENT` (20), `MAX_QUOTE_CHARS` (2,000 typed
characters), because a comment that can embed a whole post is a way to republish one.

### The matcher

Three modules: `comment-quote-match.ts` (pure, browser-safe: normalize, flatten, the tiers,
`matchQuoteAcross`, with a unit table), `comment-quote-extract.ts` (which spans of a body are
candidates, and the rewrite over a `Transform`), and `comment-quote-capture.ts` (server-side:
loads the targets through Prisma, runs the two, returns the rows). `captureCommentQuotes` is
called by `submitComment`, `editComment` and the e2e seeder alike; the rich composer's
pending quotations arrive as hints (`comment-quote-pending.ts`, at most `MAX_PENDING_QUOTES`)
and are never trusted as the answer.

**Candidates**, all immutable, all admissible, loaded lazily in priority order and flattened
once per submission: the parent comment's newest revision when replying, the host post's
current publication event, then every public comment on the post newest first (up to 200),
plus any target a hint names — that is how an off-page post or comment becomes a candidate
at all. Across candidates, priority wins: a reply quoting words that appear in both the
parent and the post is quoting the parent.

**Extraction.** Every outermost blockquote, its text being its textblocks joined by a
newline; and inline runs inside straight or curly *double* quotes within one textblock, not
crossing a hard break, not under the `code` mark, at least `MIN_INLINE_QUOTE_CHARS` (12)
long. Single quotes are apostrophes too often.

**Normalization**, both sides, with an index map back: NFKC, curly quotes and apostrophes to
straight, dashes to a hyphen, an ellipsis to three dots, whitespace runs to one space,
trimmed. Not case-folded and not punctuation-stripped — copy-paste preserves both.

**Flatten with a position map**, search with `indexOf`, map the hit back — the technique
docs/COLLAB.md §4 rejected for live surfaces, safe here for the three reasons COLLAB.md §9
states: the target is immutable and the search runs once at post time; **every hit is
verified** after mapping back (`normalize(quotedTextAt(range))` must equal the normalized
query, or share its ends for the fuzzy tier); and the stored text is derived from the
verified range, never taken from the query. A flattening mistake costs a missed match,
never a wrong anchor. Don't lift this search into a live surface.

**Tiers**, first hit wins: the rich composer's hinted range in its named target, verified;
exact normalized substring across candidates; **ends** — the first and last `END_CHARS` (32)
of the query both found in one candidate, in order, the span between within a fifth of the
query's length, so the fuzzy tier needs a quote of at least 65 normalized characters and a
short misquote stays unmatched rather than guessed at; then no match. Within one candidate
with several occurrences, the nearest to the thread's own passage anchor if there is one,
else the first — a deliberate departure from `resolveAnchorInDoc`'s exactly-one rule, since
identical text in one immutable object is the same words by the same author and nothing
highlights the position in the article yet.

**`quoted_text` is `quotedTextAt(node, from, to)`** — `textBetween` with a space as block
separator *and* as leaf text, so a hard break inside the quoted words does not glue two
words together. The rewrite, the integrity check and the matcher's verify all derive with
that one function.

**On edit, the anchor rows are replaced wholesale** (`deleteMany`, then `create`), with the
pinned versions the old rows named searched first, so a quotation that still matches re-pins
to the version it already had under a new row id. `clearUnassignedAnchorIds` empties the
body's old ids, so a stored body never names a row that does not exist.

### The gestures

`CommentQuoteProvider` (`comment-quote-context.tsx`) wraps the post page. Composers register
under a key (`post:<id>`, `reply:<commentId>`, `edit:<commentId>`, the passage popover's),
mark themselves active on focus, and `quoteInto` delivers to a preferred composer, the active
one, or the general form; a reply form not yet open is opened by its card and the request is
delivered when it registers.

- **"Quote in comment instead"** in the article's existing selection popover, carrying the
  editor's offsets as the hint.
- **"Quote in reply"** (`CommentQuoteSelectionPopover`) over a selection in any card: one
  `selectionchange` listener for the page, `pointerup` short-circuiting it, floating-ui
  placement.

In Markdown mode either gesture appends a `> ` block and nothing else — the matcher finds it
again. In rich mode it inserts an anchored blockquote with a `pending:` placeholder id and
records the hint in the value and the draft. **Both gestures insert a block quote**; an
inline quotation is typed as `"…"` in either mode and found by the matcher.

**Quoting something not on the page** is `CommentQuotePicker`, a panel under the composer
("Quote from elsewhere…") rather than a floating menu, because a body to select text in needs
room. `searchQuotableTargets` runs `/search`'s substring search over published posts plus a
`bodyText` search over public comments, without a session, since the admitted set *is* the
public set; `loadQuotableTarget` returns the chosen body, gated by `canQuoteTargetInto`, and
the panel renders it statically (memoed — see "Rendering") for a selection. "Quote
selection" hands the composer a request naming the target, which is what makes an off-page
object a candidate. **A hint may be unbound** (`id: null`): the Markdown box has no
placeholder ids, so its hints name a target to search without saying which `> ` block is
which, and the matcher sorts that out.

**PDFs.** A `file` hint kind carries the viewer's `PdfTarget` blob; in `captureCommentQuotes`
a span bound to one goes through `canQuoteTargetInto` and, if admitted, `capturePdfTextAnchor`
— a `PDF_TEXT` row with no stamp. The gate admits no file, so today that branch degrades every
time, and `comment-quoting.spec.ts` asserts the refusal. No PDF-side gesture exists: the
composer lives on a post page and the viewer does not, so the natural form is a picker over
files once there is a file a stranger may read.

### The citation

`loadCommentQuoteCitations` (`src/lib/comment-quote-data.ts`) is one query for every comment
on a page, keyed by quoting comment then by anchor id; `describeQuoteTarget` resolves each row
to a label and an href, filtered by the audience rule at render. A comment target's href is
the post path plus the comment's permalink fragment. When a comment quote's pinned revision is
not the newest, the citation reads "quoted an earlier version" — which also cancels that
version's silence in the history. A row whose target is no longer public renders "a source
that is no longer available", with no link.

**A quotation of the host post is not a thread anchor.** A `>` block that matches the
article from the general form creates an anchor row and leaves the comment in the general
thread. A passage thread says what a discussion is *about* and is remapped on publish so the
article can highlight it; a quote anchor says what a body *quotes* and pins an event. Two
mechanisms on purpose.

## Caching and the post page

The post page is statically generated with `revalidate = 60`. **Everything a reader does to
a post invalidates its page on the spot**: `submitComment` calls `revalidatePostPage`
directly, and editing, deleting and moderating go through `revalidateTouchedPosts`; the
form's `router.refresh()` then fetches the new render, so a commenter sees their own comment
immediately. Nothing about an *author* is revalidated onto it — CACHING.md's 2026-09-17
entry. The e2e suite writes comments straight into Postgres, which no action does, so every
navigation that depends on such a write is a `freshGoto`.

## Verification

- **Unit** (`npm run test:unit`): `comment-body.test.ts` (the rejection surface: depth, size,
  hrefs, out-of-schema nodes), `markdown-comment.test.ts` (each shim, the round trip),
  `comment-quote-match.test.ts` and `comment-quote-extract.test.ts` (normalization, tiers,
  extraction, the rewrite), `edit-grace.test.ts`.
- **Integrity** (`scripts/integrity/README.md`): `check-comment-revisions.ts` holds
  `comment.body` and `body_text` to the newest revision and checks dense numbering and
  revision 1's timestamp; `check-comment-quotes.ts` holds the three copies of a quotation —
  body span, `quoted_text`, the target at the pinned version — to one string;
  `check-tag-constraints.ts` probes the CHECKs. Nothing runs them automatically.
- **e2e**: `moderation.spec.ts`, `comment-editing.spec.ts`, `comment-markdown.spec.ts`,
  `comment-quoting.spec.ts`, and `quote-anchoring.spec.ts` for passage threads. Fixtures:
  `createComment()` writes revision 1 and links the commenter to a `User` when one exists
  with that email (pass `ADMIN_EMAIL` to make "edit your own comment" reachable);
  `createCommentWithQuotes()` runs the real parse → match → rewrite path without the form;
  `getCommentFacts()`, `getCommentQuoteFacts()`, `backdateComment()`.
- **The grace window is not tested with `page.clock`.** The rule compares two stored
  timestamps and never reads a clock; `backdateComment()` produces the interval directly. A
  "no marker appeared" assertion should also assert on `getCommentFacts()`, since a silent
  edit still writes a revision.
- **The per-IP budget.** Every worker shares one IP, and the form limit is five in ten
  minutes; `moderation` (1), `comment-markdown` (2) and `comment-quoting` (1) spend four.
  A new spec that must post through the form should seed instead, or the sixth post in a
  run fails as "too quickly" and reads like a regression.

## Decisions, and the alternatives rejected

The reasoning behind the sections above, where the plan weighed something else.

- **Every version is kept; the window is a display rule.** The alternative — skipping the
  revision insert inside the window, so that "nothing visible" meant nothing stored — leaves
  a quotation taken inside the window with nothing to pin to, and gives moderators and the
  integrity script nothing to check. Storing costs nothing at 5,000 characters a version.
- **The window is measured from posting, not from the last edit.** Measured from the last
  edit, a chain of edits each under three minutes apart would stay silent forever. The ask
  was a short window to fix a typo after posting, which is a property of posting.
- **A quotation closes the window.** A reply that quotes "the sky is green" is a reply to
  those words; if the author silently changes them a minute later the reply reads as a
  non-sequitur with no explanation available to anyone. So a quote taken in the window makes
  the version it pins visible. It is never a reason to refuse the edit.
- **A constant, not a `site_settings` column.** No one has asked for a second value;
  `/site-settings` can grow one later without a migration of meaning, and `EDIT_GRACE_MS`
  sits beside the predicates so there is one place to convert.
- **Annotations get the same window.** The ask named it for comments; a second rule to
  explain would cost more than it bought, and both are one line to change.
- **Moderation state survives an edit, except a spam hit.** Re-running the cascade and
  sending an untrusted commenter's edit back to `PENDING` is the stricter policy, but it hides
  the comment until re-approved unless status is per revision — deferred with that
  prerequisite named. A moderator's edit is attributed to the moderator on that version,
  which needs no extra column.
- **Rich bodies were forced by inline quotation, not by editing.** The editing work kept the
  `{ text }` envelope deliberately. A quotation that can sit *inline* is structure inside the
  body, and "most styling" is structure by definition, so the safe-schema item the comment
  design had carried since the beginning stopped being deferrable at that moment. The
  precedent was `contributorBlurb`: TipTap JSON validated by `nodeFromJSON` on write, so the
  schema is the validation and there is never any HTML to sanitize — stronger than an HTML
  allowlist, and with no sanitizer to keep in step.
- **A quotation is an anchor row, not columns on the comment.** The first build put four
  columns on the reply — pinned revision, two offsets, the quoted text — which answer "which
  passage of my parent does this quote". They cannot answer "which passage of which of five
  kinds of object does this *span* of my body quote", and widening them would mean a fifth
  and sixth nullable column set with a CHECK nobody could read. The envelope already existed
  for exactly this, so the anchor work was a third consumer of an existing library, which is
  the single largest reason the ask was affordable at all.
- **`POST_RANGE` is not added; `DOC_RANGE` names the mechanism.** The tags plan reserved the
  name until part-anchors joined the thread remap. A quotation needs no remap: it pins the
  event it was taken against and reproduces that text forever, where a *thread* must stay
  attached to the live article to be highlighted in it. And `DOC_RANGE`'s blob and columns
  already describe "offsets into a ProseMirror document with enough context to re-find them",
  which is exactly what a post range is — the kind names the mechanism, the arc and the stamp
  name the substrate, and the tags work already reads it that way against an annotation
  body. A `POST_RANGE` differing in no field would be an enum value carrying no information.
  If a quotation's highlight should ever survive publishes, extending `remapThreadsToEvent` to
  carry post-targeted quote anchors is additive.
- **A quotation does not follow its target's edits.** It pins a revision, which is the point;
  the citation says the target has changed since.
- **Anonymous commenters may quote.** The audience rule makes a leak structurally impossible,
  and the rate limit and moderation cascade already govern abuse.
- **The article does not highlight a comment's quotation of it, yet.** The thread decorations
  could show "three people quoted this sentence"; a genuinely nice feature with its own packing
  and colour questions, deferred, additive, needing no schema it does not have.
- **Comments and annotations did not become one component again.** They were un-shared
  because the two had stopped having the same rendering problem; they now have *similar*
  ones, which is not the same one — an annotation body is a live ydoc with presence and a
  mark-free schema, a comment body is a validated JSON column with quotations in it.
  `EditHistory` is the one shared piece, because the silence rule is one rule.
- **The trust threshold is inert wherever the cascade resolves to `auto`.** The trust check
  runs before the cascade, but an untrusted commenter who fails it still falls through, and a
  cascade resolving to `auto` publishes them anyway. The threshold only changes an outcome
  where the resolved policy is `always`, so raising or lowering it does nothing until something
  in the cascade resolves to `always` at least some of the time.

## Deviations from the plan

From PLAN.md §22 (editing):

- **The edit rate limiter counts revisions, not comments.** §22c said `editComment` would
  reuse `isCommentRateLimited`; that function counts `comment` rows and is blind to editing.
- **The "edited" marker's condition is computed by the loaders**, not per comment, which
  would be an N+1; and only the timestamps are loaded, never the bodies.
- **Comment history renders rich bodies.** §22 planned plain-text history; §23 made bodies
  rich, and the island renders each version through `CommentBody`.
- §22d — a quotation as four columns on the reply — was built and superseded before it was
  merged ("History" below).

From PLAN.md §23 (rich bodies and quotation):

- **`POST_RANGE` is not added**; `DOC_RANGE` names the mechanism ("Five substrates").
- **Three matcher modules rather than two**, with the extraction and rewrite between the
  pure matcher and the Prisma-backed capture.
- **Candidate priority is parent, post, then every public comment newest first** — one
  query rather than "thread first, then page", and the difference only decides ties.
- **The fuzzy tier needs 65 normalized characters**; an inline candidate needs 12; only
  double quotes delimit one.
- **The block form is an attribute on `blockquote`**, not a `Quotation` node: Markdown
  parses to `blockquote`, so promoting a match is an attribute write, and degrading is
  `anchorId: null` rather than a node-type swap. The "no nested anchored quotes" exclusion
  is a server rule (outermost only) rather than a content expression.
- **Markdown is the default mode**, and switching modes with content is a server round
  trip.
- **The migration made one paragraph per line** of a pre-§23 comment, so line breaks
  survived; `body_text` was derived the same way.
- **Links are hardened twice**, on the stored mark and on the renderer.
- **Unbound hints ride in Markdown drafts.** §23g said a Markdown draft carries no pending
  anchors; the off-page picker needed a way to name a target from the Markdown box, and the
  unbound hint is it.
- **The rewrite's input is a resolution carrying its paragraphs**, not a source document and
  range, so that the PDF branch (whose "source" is page text) could share it.
- **The table shim** emits one paragraph with hard breaks between rows rather than one flat
  line.

## Not built, deferred

- **No inline quote gesture.** Both gestures insert a block; inline is typed. A gesture
  would insert the `Quote` mark with a pending id; the server needs nothing new.
- **No highlight of quotations in the article or in a quoted comment's card.** The cards
  are static renders with no decoration layer; the citation link is the connection.
- **PDF quoting** waits on a public file tier (PLAN.md §19); the mechanism exists behind the
  gate.
- **Code fences degrade** to `code`-marked lines; adding `CodeBlock` to the schema is the
  cheaper fix if that reads badly on a technical post.
- **No diff between versions**; the history lists them whole.
- **No per-revision moderation status**, so an edit keeps its status except on a spam hit.
- **The grace window is a constant**, not a `site_settings` column.
- **Anonymous commenters cannot edit**; an emailed edit link is the honest self-service path
  (docs/EMAIL.md's deferred list).
- **An elided quote** — two pieces around a gap, matched as a multi-part anchor over
  `part_order` — is a natural fifth tier and the first real use of the part-set.
- **Promoting a matched quote into a passage thread** is a plausible later gesture, not a
  default.

TODO.md carries the actionable subset.

## History

Editing was built first (PLAN.md §22), with a comment's quotation as four columns on the
reply. Before it merged, the ask grew to several quotations of five kinds inside the reply's
prose, which needed rich bodies and the anchor envelope; §23 is that design. The editing
work was parked on a reference branch with its migrations reverted from the local database,
and the first of its commits — grace window, `comment_revision`, annotation edit sessions —
was cherry-picked back as §23's Phase 0 (`e2d3a15`). The superseded quotation design and the
branch were deleted on 2026-09-17; nothing on this branch depended on them.

Migrations, in order: `add_comment_revisions`, `add_annotation_edit_sessions`,
`rich_comment_bodies`, `comment_quote_anchors` (all 2026-09-16).
