# Integrity checks

Twelve scripts. Three are about the doc/ydoc chain and are described first; then three about
the PDF side, one about the schema itself, the three that arrived with PLAN.md §22 and
§23 — the two edit-history checks and the quotation check — the mentions check, and the search
index's at the bottom.

The doc/ydoc three: two verify one link each in the chain that turns an append-only
log into the columns the app reads; the third verifies a claim made *about* a
point in that log:

```
ydoc_update  →  ydoc.ydoc  →  doc.title / doc.prose_json / doc.prose_json_length
└─ check-ydoc-integrity ─┘    └────────── check-doc-integrity ──────────┘
     ↑
     └── annotation.{anchor_from, anchor_to, quoted_text} @ ydoc_update_id
         └────────────── check-annotation-anchors ──────────────┘
```

Neither derives anything on read. `ydoc.ydoc` is what a live editing session
loads; the `doc` columns are what `/docs`, search and every non-editing surface
read. Both are written once, by the collab server's store debounce
(`server/doc-cache.ts`) and by the `doc_sync_prose_json_length` trigger, and
neither is ever recomputed to check itself. So a break anywhere in that chain is
silent by construction — the app keeps serving a stale or wrong value
indefinitely, with nothing failing. That is what these exist to make loud.

| | asks | fails on |
|---|---|---|
| `check-ydoc-integrity.ts` | does the stored blob match a replay of its own update log? | ERROR — a divergence here means the document and its history disagree |
| `check-doc-integrity.ts` | do the Doc columns match the stored blob? | mostly WARN, since a cache legitimately trails the ydoc by one debounce; `length-cache` is an ERROR because nothing explains or fixes it |
| `check-annotation-anchors.ts` | replay to an annotation's stamp — is it actually anchored there? (its quote, and the entity chips its record names, for a column anchor; its mark, for a mark anchor) And does each chip record's label match its chip's label now? | ERROR, except a missing stamp (WARN: rows predating the column are legitimately in that state) and a stale record label (WARN: a lost refresh, repaired by the doc's next store, or for an anchor into a note, its next edit) |

Run all three:

```bash
npx tsx scripts/integrity/check-ydoc-integrity.ts \
  && npx tsx scripts/integrity/check-doc-integrity.ts \
  && npx tsx scripts/integrity/check-annotation-anchors.ts
```

Each exits non-zero on an ERROR-level finding and zero on WARNs, so the pair can
gate a deploy or run from cron. Each takes `--verbose` and an id filter; see the
header comment in each file for its own flags and the full list of what it
checks — that is where the reasoning lives, not here.

## Why they're split

The split is by *reference*, not by convenience. `check-ydoc-integrity` replays
the log and trusts nothing else. `check-doc-integrity` takes the blob as given
and compares the columns to it — deliberately, because the blob is what
`doc-cache` actually reads, so it is the honest answer to "should this column
look like this?". If the blob itself is wrong, that is the first script's
finding; duplicating it in the second would double-count one fault and make a
single corruption look like two unrelated ones.

The practical consequence: **when both report problems, fix the ydoc one first.**
A bad blob will produce doc-cache findings that evaporate once the blob is
repaired from its log.

`check-annotation-anchors` sits at the same point in that ordering and for the
same reason — it replays the log, so a corrupt log makes it report anchor faults
that are really one ydoc fault wearing several hats. Run it third.

It is the odd one out in what it verifies. The other two ask whether a *derived*
value still matches what it was derived from. This one asks whether a claim
written down once — "at update N, characters [a, b) of this document read
exactly this" — is still true of the history. Nothing recomputes that claim, and
PLAN.md §13o's design depends on it: the reading views search for the stored
quote as ground truth, and COLLAB.md §7's eventual repair would diff *from* the
stamped state. If the claim is wrong, both silently anchor to the wrong passage
rather than failing.

## When to run them

- After either one-shot import (`scripts/import-legacy.ts`,
  `scripts/etherpad/import-etherpad.ts`) — this is their acceptance test, and
  the blob-vs-log class of corruption is exactly what the legacy import
  surfaced.
- After anything that writes doc bodies in bulk, especially with
  `DISABLE TRIGGER` or `COPY` — that is the one way `prose_json_length` can go
  wrong, and the only check here that reports a genuine fault rather than lag.
- Not usefully mid-editing-session: `title-cache` and `body-cache` compare a
  cache against a source that is legitimately ahead of it, so an active editor
  produces differences that are not faults. They are `--verbose`-only for that
  reason.

## `check-pdf-anchors.ts` (PLAN.md §19)

The file-side sibling of `check-annotation-anchors.ts`, and the odd one out in the same way:
it verifies a **claim written down once** — "on page N, characters [a, b) of the normalised
text read exactly this" — rather than a derived value. Nothing recomputes it, so nothing
else would ever notice it breaking.

It is a separate script rather than a branch inside `check-annotation-anchors.ts` because the
two check different things against different substrates. A doc annotation's anchor is
verified by replaying a ydoc to a stamped version; a file has no ydoc to replay — a
version's bytes are immutable, which is precisely why its anchor is checked against the
stored page text (`file_page_text`) instead: the page text of the version the anchor names
(`file_version_id`, docs/PDF.md §13), whichever version is now the file's latest.

What it can and cannot see:

- **Can**: a quote that disagrees with the page text at its own offsets; a target whose
  `textVersion` has no matching extraction; a `pageIndex` past the end of its version; a
  malformed target blob; a quote stored with no target at all; a target that names no
  version.
- **Cannot**: the quads. They are geometry, and checking them would mean rendering the PDF,
  which needs a browser. They are also the part least likely to be wrong — they were
  measured against bytes that cannot change.

```
npx tsx scripts/integrity/check-pdf-anchors.ts [--file <idOrSlug>] [--verbose]
```

Unlike the other three it does **not** need to run after the ydoc check: it touches no ydoc
at all, so its findings are never downstream of a bad blob.

## `check-file-versions.ts` (docs/PDF.md §13)

Every file has a latest version, and the version it names is one a reader may be shown;
every anchor into a file names a version it may be on; and every page map, move and "stays
here" mark is one the write layer could have made.

A file and its first version name each other, so `file.current_version_id` is nullable for
the one step in which the file exists and its version doesn't, inside the transaction that
makes both. The database therefore can't say "every file has a latest version", and every
reader of a file's bytes goes through `latestVersionOf`, which throws on a file without one:
a broken page, a search query that throws, an MCP read that fails, and nothing reporting it
until someone opens that file.

It reports a file with no latest version (`no-latest`), one whose latest was never promoted
or is abandoned, one with no version 1, and one whose versions are not numbered 1 to their
count. All are ERRORs. The pair key already makes the latest one of the file's own versions;
`check-tag-constraints.ts` proves that key.

**Every version that is not abandoned has its bytes on disk** (`no-bytes`), and an abandoned
one has no page text left (`abandoned-with-text`). Abandoning removes a blob before its
transaction commits, under a lock on the hash that every upload takes, so a version without
bytes is a commit that failed after the removal, a database restored without its
`FILE_STORAGE_DIR`, or a write that skipped the lock.

**Every anchor into a file names a version it may be on**, over all four tables that can
hold a PDF target (`annotation`, `tag_anchor`, `anchored_link_anchor`,
`comment_quote_anchor`):

- `anchor-without-version`: a row with a PDF target names no version. The tables' CHECKs
  refuse it, and this reads the claim back.
- `anchor-on-candidate`, `anchor-on-abandoned`: a capture checks its version inside the
  transaction that inserts it, and a candidate takes no note or link part, since abandoning
  it removes the sheets the anchor was measured on. This is the one thing that reports an
  anchor that got through.
- `unmoved-kind`: a `tag_anchor` or `comment_quote_anchor` row holds a `PDF_TEXT` selector on
  a file with more than one version. Neither table has a writer of one, and nothing would
  move such a row to a later version, so one appearing means a writer was added without its
  place in the move.

**Every page map pairs sheets that exist, and no two with one counterpart**
(docs/PDF.md §13, "Matching the pages"). A link is carried through each map it meets and
lands where the map says, so a map that is wrong sends every link through it to the wrong
sheet, and nothing else reads a map back:

- `map-unreadable`: a version's `page_map` is not a map. Every reader takes such a value
  for no map, so links stop being carried there and nothing says why.
- `map-without-base`: a version holds a map and names no base for it to be from.
- `map-fault`: the map is of another number of sheets than its base has, or onto another
  number than its version has; two sheets of the base have one counterpart; an accepted run
  of sheets is not written in, or one that is not accepted has a sheet paired. One line per
  fault (`pageMapFaults`, `src/lib/pdf-page-map.ts`).

An abandoned version's map is checked too: a link that names the version is still carried
through it.

**Every move went forward, and every anchor is where its history says**, over
`file_anchor_move` (docs/PDF.md §13, "Moving a note forward"). A move's row is what an
undo reads, so a row that is wrong undoes to the wrong place. A "stays here" mark is a row
of the same table that reaches no version, and is in none of the move checks:

- `move-off-file`: a move or a mark names a version that is not one of its anchor's
  file's, or its anchor is into no file.
- `move-to-unpromoted`: a move reached a version that was never promoted, or was abandoned.
- `move-not-forward`: a move reached a version that is not later than the one it left.
- `move-chain-broken`: a move left another version than the one its anchor's move before
  it reached.
- `anchor-not-where-moved`: an anchor is not on the version its newest move reached.
  Newest is by `id`, which is from a sequence, never by `moved_at`: two moves in one
  transaction share a time.

**Every "stays here" mark names the version its anchor is on**:

- `mark-off-version`: a mark names another version. A move of a marked note takes the mark
  off in its own transaction, so one left behind is a write that went round it, and it
  would hide the note from its author's worklist and from every carry.
- `mark-on-latest`: a mark names its file's latest version, where there is nothing to stay
  behind from.
- `two-marks`: an anchor has two. The table's partial unique indexes refuse it, and this
  reads the claim back.

After a carry is undone from the database (docs/PDF.md §13, "Writing a move"), this is the
check to run: it says whether every anchor the undo touched is where its remaining history
says.

```
npx tsx scripts/integrity/check-file-versions.ts [--file <idOrSlug>] [--verbose]
```

## `check-pdf-fragment-links.ts` (docs/PDF_FRAGMENT_LINKS.md §9)

The PDF side's other check, and the only one here that verifies something with no row behind
it. A fragment link (`/pdf/<slug>#sheet=<n>&text=<words>`) lives in an href, and the viewer
finds its passage again on every open, so a link with the wrong page, a word the PDF spells
differently, or a pdfjs bump that changes what a page extracts shows only when someone
follows it. This finds every one in docs, posts, comments and annotation bodies, and resolves
each passage against the stored page text of the file version it names, with the viewer's
own match. It reads a link as the viewer does (docs/PDF.md §13, "Links into the file"): its
`v=` names the version, or without one the version its own address names, or the file's
first.

- **ERROR**: a passage not on its page (with where it stops matching, and the page it is on
  when that is unambiguous), a page past the end, an unknown or deleted file, a `text`
  parameter that doesn't parse, a `v=` naming a version the file never had.
- **warn**: a passage its page holds more than once (the link points at the first), a
  link naming a file's past slug, which still works through the slug-history redirect, a
  link naming an abandoned version, which nothing can confirm, a link on one version's
  address that names another, and **a link without `v=` written after its file's second
  version was uploaded**. The viewer reads such a link as the first version's, since it
  can't tell when a URL was written. The check can: it dates a link by the update log
  (`src/lib/pdf-link-dating.ts`), and one that postdates the second version was typed by
  hand, most likely for the latest.

A link that names an earlier version and finds its words there is no fault, though the
latest lacks them: `--verbose` lists it.

It is read-only, never extracting a file's text on a miss as `storedPageText` would. Run it
after importing a doc that carries fragment links, with `--doc`, and after
`upgrade-pdf-text-version.ts` on a pdfjs bump.

```
npx tsx scripts/integrity/check-pdf-fragment-links.ts [--doc <idOrSlug>] [--verbose]
```

## `check-tag-constraints.ts` — the odd one out, again

Every other script here verifies **stored data**. This one verifies the **schema**: that
`add_tags`' two hand-written CHECK constraints and its `lower(name)` unique index actually
reject what their comments claim, by attempting each violation inside a transaction it always
rolls back. It has grown with every anchor table since: `add_anchored_links`' CHECKs and
partial index, and `comment_quote_anchors`' three CHECKs (PLAN.md §23c) plus the one probe
that matters most there — a `tag_anchor` with both a doc and a comment target must be refused,
which proves the rewritten one-target CHECK *counts* the fifth arc column rather than merely
tolerating it.

It exists because nothing else can reach them. `npx tsc --noEmit` sees TypeScript, and every
violation is well-typed. `npm run e2e` drives the UI, and the UI never attempts one — the
server actions build valid rows by construction, so a suite that only walks the happy path
cannot tell a live constraint from a comment describing one. And a migration that silently
failed to add a constraint (docs/DATABASE.md's edit-an-applied-migration recipe, a restore
from a dump taken before it) leaves a database that behaves correctly right up until
something writes a bad row.

Run it after either of docs/DATABASE.md's two migration recipes. It also prints its own
**known residuals** — what the specified CHECK deliberately does not catch — because "which
constraint covers this?" is the question it exists to answer, and an honest answer includes
the gaps.

`check-annotation-anchors.ts` also walks `tag_anchor` since PLAN.md §20g: the replay
invariant is a per-row property, so one checker covers every anchor table rather than one per
consumer family. In PR 1 that walk reports `0 of 0` — every tag anchor is whole-object and
makes no claim about any text — and the zero is itself the assertion that PR 1 kept its
tie-off promise.

Since docs/ANCHORED_LINKS.md, the same one-walk-per-invariant rule covers
`anchored_link_anchor` — the third table on the §20a envelope, and the first with real part
rows on main: its `DOC_RANGE` parts join `check-annotation-anchors.ts`'s replay walk, its
`PDF_TEXT` parts join `check-pdf-anchors.ts`'s page-text pass, and `check-tag-constraints.ts`
probes its two CHECKs plus, on `anchored_link` itself, the `anchored_link_one_open_per_user`
partial unique index and the reopened-only-when-minted CHECK (both directions: a second open
draft must be refused, as must a reopened link beside a draft and `reopened_at` on a draft; a
second link for a user whose first is *minted* must go in, as must a reopened link once the
slot is free), and the not-blank CHECK on `name` (a whitespace-only name must be refused; a
real one must go in — docs/ANCHORED_LINKS.md, "Naming a link").

docs/PDF.md §13's migrations (`file_versions`, `file_version_anchor_checks`) add theirs: the
one-candidate partial index on `file_version`, the pair keys that make a file's latest
version and an anchor's version one of that file's own, and the CHECK on each anchor table
that a row names a version exactly when it holds a PDF target. A whole-file `tag_anchor`
naming a version is the probe that matters most: its `selector_kind` is NULL, which a plain
equality in the CHECK would let through.

## `check-comment-quotes.ts` (PLAN.md §23)

The pair §23f rests on, checked for every `comment_quote_anchor` row: the quoting body's span
that names the row carries exactly `quoted_text`, and `quoted_text` is exactly the target's
words at the pinned version — a publication event's `prose_json` for a post, a
`comment_revision`'s body for a comment, both immutable, so "exact, forever" is the standard.
Three copies of one string, written once from a verified match; a divergence is a fault in
the write path or a body rewritten without re-running the capture, and nothing on the read
path would notice — the body renders its own words with no join, by design.

```
npx tsx scripts/integrity/check-comment-quotes.ts [--post <id>] [--verbose]
```

Touches no ydoc; run any time. A doc, file or annotation target is a WARN: none has a writer
(§23e), so a row with one came from somewhere else.

## `check-comment-revisions.ts` and `check-annotation-snapshots.ts` (PLAN.md §22)

The two edit-history checks. Both verify that a cache still equals the newest stored version,
and they differ in what a version *is* — a `comment_revision` row holding text, or a
`ydoc_snapshot` on an annotation body's own ydoc holding a settled state — which is why they
are separate scripts rather than one with a branch.

`comment.body` and its newest `comment_revision` are written in a single transaction, so there
is no legitimate staleness window at all and any divergence is a fault. Since PLAN.md §23 both
are ProseMirror JSON and the comparison is of their derived text; the same script also holds
`comment.body_text` to that text (`body-text`), because /comments' filter searches the column
and a drift there is a search that silently misses. An annotation's cache and its newest
snapshot are written in one transaction too, from one decoded document, so `settled-cache` on
that side is a fault as well; what can still produce one is a body written to by something
other than a settle while no session was open, and the message names the repair — open and
close an edit session, which settles what is there now. It also has a `stale-session` WARN for
a session someone abandoned, which is not a fault at all.

Between them they also check what the *history view* needs to be trustworthy, none of which
Postgres can state:

- dense, 1-based `revision_no` on the comment side, and strictly increasing marks with
  non-decreasing timestamps on the annotation side (`monotone`), because §22b's silence rule
  pairs each version with its successor and a pair out of order turns a visible edit silent or
  the reverse;
- the posting moment the grace window is measured from — the comment's own `created_at` on one
  side, `annotation.posted_at` with at least one snapshot on the other (`posted-snapshot`).

Whether each annotation snapshot's *bytes* equal a replay of the body's log to its mark is
`check-ydoc-integrity.ts`'s check 4, which already covers every ydoc, annotation bodies
included; the annotation checker does not repeat it.

```
npx tsx scripts/integrity/check-comment-revisions.ts [--post <id>] [--verbose]
npx tsx scripts/integrity/check-annotation-snapshots.ts [--doc <id>] [--verbose]
```

Run the annotation one after `check-ydoc-integrity.ts`, for this folder's usual reason: it
decodes snapshots, so a corrupt one makes it report cache faults that are really one ydoc fault
wearing several hats. The comment one touches no ydoc and can run any time.

## `check-mentions.ts` (docs/ENTITY_CHIPS.md, step 1, item 12)

The `mention` table is written by triggers and read by things that would not notice it being
wrong. The label refresh after a rename finds the docs to rewrite through it, so a missing row
is a doc that goes on showing, and being found by, the old name.

- `trigger`: each of the three triggers `mention_index` created exists and is enabled.
- `missing`: a mention chip in a doc, a posted note or a post with no row. The expected rows
  come from the functions the triggers call, so the two cannot disagree about what a document
  mentions. A chip naming no account has no row by design.
- `extra`: a row whose chip its document no longer holds, or one for a DRAFT note.

`--repair` runs the triggers' own diff for each drifted source, so rows whose chips are still
there keep their `first_seen_at`. It refuses while a trigger is missing or disabled.

```
npx tsx scripts/integrity/check-mentions.ts [--verbose] [--repair]
```

## `check-search-index.ts` (docs/FULLTEXT.md §3)

The six `search_vector` columns and the `search_lexeme` vocabulary are written by triggers and
read by nothing that would notice them being wrong: a drifted vector is a search that silently
misses, and a lexeme missing from the vocabulary is a typo that silently goes uncorrected. It
is the search index's `length-cache`, for the same drift surface — a trigger can be disabled,
and a load can go around it.

- `trigger`: every trigger `add_full_text_search` created exists and is enabled.
- `vector`: each row's vector equals its kind's SQL function over the row's own columns —
  the function the trigger itself calls, so the two cannot disagree about the right answer.
- `vocabulary`: every lexeme of every vector is in `search_lexeme`. The vocabulary triggers
  add only what a statement introduced, relying on this being true already, so a gap never
  closes by itself.
- `stale` (a WARN): vocabulary rows no vector holds. Harmless, and the table never shrinks on
  its own.

`--repair` re-fires the row triggers for drifted rows and rebuilds the vocabulary from
`ts_stat` under a lock that holds the triggers' own inserts off until it commits. It refuses
while a trigger is missing or disabled, since firing them would then fix nothing.

```
npx tsx scripts/integrity/check-search-index.ts [--verbose] [--repair]
```

Touches no ydoc and has no staleness window to excuse — a vector is written in the same
statement as its text — so it can run any time. Run it after a data-only load
(docs/DATABASE.md) and after anything that writes these tables with triggers disabled.
