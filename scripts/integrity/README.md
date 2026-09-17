# Integrity checks

Five scripts — three about the doc/ydoc chain, one about the PDF side, one about the schema
itself, plus the two §22 revision checks described at the bottom. The count in the next
sentence is the original three.

Three scripts. Two verify one link each in the chain that turns an append-only
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
| `check-annotation-anchors.ts` | replay to an annotation's stamp — is it actually anchored there? (its quote, for a column anchor; its mark, for a mark anchor) | ERROR, except a missing stamp (WARN: rows predating the column are legitimately in that state) |

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
verified by replaying a ydoc to a stamped version; a file has no ydoc and no version to
replay to — its bytes are immutable, which is precisely why its anchor is checked against
the stored page text (`file_page_text`) instead.

What it can and cannot see:

- **Can**: a quote that disagrees with the page text at its own offsets; a target whose
  `textVersion` has no matching extraction; a `pageIndex` past the end of the document; a
  malformed target blob; a quote stored with no target at all.
- **Cannot**: the quads. They are geometry, and checking them would mean rendering the PDF,
  which needs a browser. They are also the part least likely to be wrong — they were
  measured against bytes that cannot change.

```
npx tsx scripts/integrity/check-pdf-anchors.ts [--file <idOrSlug>] [--verbose]
```

Unlike the other three it does **not** need to run after the ydoc check: it touches no ydoc
at all, so its findings are never downstream of a bad blob.

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
